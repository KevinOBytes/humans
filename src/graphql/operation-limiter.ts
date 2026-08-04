import { createHmac } from "node:crypto";

import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { GraphQLActor } from "@/graphql/context";
import {
  noopSecurityEventLogger,
  type SecurityEventLogger,
} from "@/lib/observability/security-events";
import type { RedisStore, TokenBucketResult } from "@/lib/redis";
import {
  isCanonicalClientPrefix,
  type ClientAddressClassification,
} from "@/lib/network/client-address";

export interface OperationLimitPolicy {
  capacity: number;
  refillAmount: number;
  refillIntervalMs: number;
  ttlMs: number;
}

export interface ConsumeOperationInput {
  cost: number;
  operationClass: string;
  policy: OperationLimitPolicy;
  /** Actor is the default. Workspace scope is used for shared tenant budgets. */
  scope?: "actor" | "workspace";
  clientPolicy?: OperationLimitPolicy;
}

export interface RequestOperationLimiter {
  consume(input: ConsumeOperationInput): Promise<TokenBucketResult>;
}

export type OperationBudgetObservation = Readonly<{
  dimension: "actor" | "client_prefix" | "workspace";
  durationSeconds: number;
  operationClass: string;
  outcome: "allowed" | "denied" | "unavailable";
}>;

export type OperationBudgetObserver = (
  observation: OperationBudgetObservation,
) => void;

type TokenBucketStore = Pick<RedisStore, "consumeTokenBucket">;

const operationClassPattern = /^[a-z][a-z0-9]*(?:[.:_-][a-z0-9]+)*$/u;
const HMAC_KEY = /^[0-9a-f]{64}$/iu;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_SUBJECT = /^[\x21-\x7e]{1,256}$/u;
const MAX_INTEGER = 2_147_483_647;
const TOKEN_MICRO_SCALE = 1_000_000;

function lengthPrefixed(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  return Buffer.concat([length, bytes]);
}

export function operationLimitKeyV2(input: {
  dimension: "actor" | "client_prefix" | "workspace";
  hmacKey: string;
  operationClass: string;
  subject: string;
  workspaceId: string;
}): string {
  if (
    !HMAC_KEY.test(input.hmacKey) ||
    input.operationClass.length > 64 ||
    !operationClassPattern.test(input.operationClass) ||
    !UUID.test(input.workspaceId) ||
    !SAFE_SUBJECT.test(input.subject) ||
    !["actor", "client_prefix", "workspace"].includes(input.dimension)
  ) {
    throw new TypeError("Invalid operation limit class.");
  }
  const hmac = createHmac("sha256", Buffer.from(input.hmacKey, "hex"));
  for (const value of [
    "humans:operation-limit:v2",
    input.operationClass,
    input.workspaceId,
    input.dimension,
    input.subject,
  ]) {
    hmac.update(lengthPrefixed(value));
  }
  return `humans:operation-limit:v2:${hmac.digest("hex")}`;
}

function validPolicy(policy: OperationLimitPolicy, cost: number): boolean {
  const values = [
    policy.capacity,
    policy.refillAmount,
    policy.refillIntervalMs,
    policy.ttlMs,
    cost,
  ];
  return (
    values.every(
      (value) =>
        Number.isSafeInteger(value) && value >= 1 && value <= MAX_INTEGER,
    ) &&
    cost <= policy.capacity &&
    policy.ttlMs >=
      Math.ceil(policy.capacity / policy.refillAmount) * policy.refillIntervalMs
  );
}

function validResult(
  value: TokenBucketResult,
  policy: OperationLimitPolicy,
  cost: number,
): boolean {
  const maximumMicrotokens = policy.capacity * TOKEN_MICRO_SCALE;
  const costMicrotokens = cost * TOKEN_MICRO_SCALE;
  return (
    value != null &&
    typeof value.allowed === "boolean" &&
    Number.isSafeInteger(value.remainingMicrotokens) &&
    value.remainingMicrotokens >= 0 &&
    value.remainingMicrotokens <= maximumMicrotokens &&
    Number.isSafeInteger(value.retryAfterMs) &&
    value.retryAfterMs >= 0 &&
    value.retryAfterMs <= policy.ttlMs &&
    (value.allowed
      ? value.remainingMicrotokens <= maximumMicrotokens - costMicrotokens &&
        value.retryAfterMs === 0
      : value.remainingMicrotokens < costMicrotokens && value.retryAfterMs > 0)
  );
}

export class OperationLimiter {
  constructor(
    private readonly store: TokenBucketStore,
    private readonly logger: SecurityEventLogger = noopSecurityEventLogger,
    private readonly hmacKey: string,
  ) {}

  forRequest(input: {
    actor: Pick<GraphQLActor, "id" | "principalId" | "type">;
    clientAddress: ClientAddressClassification;
    requestId: string;
    workspaceId: string;
    observeBudget?: OperationBudgetObserver;
  }): RequestOperationLimiter {
    return {
      consume: async (operation) => {
        if (
          !validPolicy(operation.policy, operation.cost) ||
          (operation.clientPolicy &&
            !validPolicy(operation.clientPolicy, operation.cost))
        ) {
          throw new TypeError("Invalid operation limit policy.");
        }
        const actorSubject =
          input.actor.type === "apiKey"
            ? input.actor.id
            : input.actor.principalId;
        if (
          (input.actor.type === "user" && !UUID.test(actorSubject)) ||
          (input.actor.type === "apiKey" && !SAFE_SUBJECT.test(actorSubject))
        ) {
          throw new TypeError("Invalid operation limit subject.");
        }
        const clientSubject = operation.clientPolicy
          ? input.clientAddress.trust === "trusted"
            ? input.clientAddress.prefix
            : "unknown"
          : null;
        if (
          input.clientAddress.trust === "trusted" &&
          clientSubject !== null &&
          !isCanonicalClientPrefix(clientSubject)
        ) {
          throw new TypeError("Invalid operation limit client prefix.");
        }
        const consume = async (
          policy: OperationLimitPolicy,
          dimension: "actor" | "client_prefix" | "workspace",
          subject: string,
        ): Promise<TokenBucketResult> => {
          const startedAt = process.hrtime.bigint();
          const observe = (outcome: OperationBudgetObservation["outcome"]) => {
            try {
              input.observeBudget?.({
                dimension,
                durationSeconds:
                  Number(process.hrtime.bigint() - startedAt) / 1_000_000_000,
                operationClass: operation.operationClass,
                outcome,
              });
            } catch {
              // Diagnostic observers never become an admission dependency.
            }
          };
          try {
            const result = await this.store.consumeTokenBucket({
              ...policy,
              cost: operation.cost,
              key: operationLimitKeyV2({
                dimension,
                hmacKey: this.hmacKey,
                operationClass: operation.operationClass,
                subject,
                workspaceId: input.workspaceId,
              }),
            });
            if (!validResult(result, policy, operation.cost)) {
              throw new TypeError("Invalid result");
            }
            observe(result.allowed ? "allowed" : "denied");
            return result;
          } catch {
            observe("unavailable");
            this.logger.log({
              event: "graphql.operation_limiter.unavailable",
              requestId: input.requestId,
              severity: "error",
            });
            throw createGraphQLError(
              "PROVIDER_UNAVAILABLE",
              publicErrorMessage("PROVIDER_UNAVAILABLE"),
              { requestId: input.requestId },
            );
          }
        };
        const primary = await consume(
          operation.policy,
          operation.scope === "workspace" ? "workspace" : "actor",
          operation.scope === "workspace" ? input.workspaceId : actorSubject,
        );
        if (!primary.allowed) {
          throw createGraphQLError(
            "RATE_LIMITED",
            publicErrorMessage("RATE_LIMITED"),
            { requestId: input.requestId, retryAfterMs: primary.retryAfterMs },
          );
        }
        if (operation.clientPolicy && clientSubject !== null) {
          const client = await consume(
            operation.clientPolicy,
            "client_prefix",
            clientSubject,
          );
          if (!client.allowed) {
            throw createGraphQLError(
              "RATE_LIMITED",
              publicErrorMessage("RATE_LIMITED"),
              { requestId: input.requestId, retryAfterMs: client.retryAfterMs },
            );
          }
        }
        return primary;
      },
    };
  }
}
