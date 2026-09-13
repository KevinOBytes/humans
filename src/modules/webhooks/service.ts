import { createHash, randomBytes } from "node:crypto";

import { and, asc, eq, isNull, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { members } from "@/db/schema/auth";
import {
  auditEvents,
  webhookDeliveries,
  webhooks,
} from "@/db/schema/operations";
import type { GraphQLActor } from "@/graphql/context";
import { createGraphQLError } from "@/graphql/errors";
import { sealEnvelope } from "@/lib/security/sealed-envelope";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  derivePrincipalResearchIdempotency,
  deriveResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  runIdempotentResearchWrite,
} from "@/modules/audit/transactions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { createJobsService } from "@/modules/jobs/service";
import { webhookPayloadHash } from "./signature";

type TransactionDatabase = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

const EVENT_NAME = /^[a-z][a-z0-9_.-]{1,63}$/u;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WEBHOOK_REFERENCE_UUID = UUID;
const WEBHOOK_IDEMPOTENCY_TTL_MS = 10 * 60_000;

function requireUser(
  actor: GraphQLActor,
): Extract<GraphQLActor, { type: "user" }> {
  if (actor.type !== "user") {
    throw createGraphQLError(
      "FORBIDDEN",
      "Webhook administration requires a user session.",
    );
  }
  return actor;
}

function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hostname.length < 1 ||
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "::1" ||
    url.hostname.includes(".") === false ||
    (url.port && url.port !== "443")
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Webhook URLs must be public HTTPS endpoints.",
    );
  }
  url.hash = "";
  return url.href;
}

function normalizeEvents(values: readonly string[]): readonly string[] {
  const events = [
    ...new Set(values.map((value) => value.trim().toLowerCase())),
  ].sort();
  if (
    events.length < 1 ||
    events.length > 32 ||
    events.some((event) => !EVENT_NAME.test(event))
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "Webhook event subscriptions are invalid.",
    );
  }
  return events;
}

function createSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`;
}

export type SafeWebhook = {
  id: string;
  url: string;
  subscribedEvents: readonly string[];
  state: string;
  secretFingerprint: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type WebhookMutationResult = {
  id: string | null;
  deliveryId?: string | null;
  code: "APPLIED" | "INVALID";
  replayed?: boolean;
  requestId: string;
  secret?: string;
};

export type WebhookServiceRuntime = {
  afterIdempotentCommit?: (operation: string) => Promise<void>;
};

function mapWebhook(row: typeof webhooks.$inferSelect): SafeWebhook {
  return {
    id: row.id,
    url: row.url,
    subscribedEvents: row.subscribedEvents,
    state: row.state,
    secretFingerprint: row.secretFingerprint,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createWebhooksService(input: {
  actor: GraphQLActor;
  database: Database;
  encryptionKey: string;
  idempotencyHmacKey?: string;
  permissions: ReadonlySet<string>;
  requestId: string;
  searchIndexMaintenance: SearchIndexMaintenance;
  workspaceId: string;
  runtime?: WebhookServiceRuntime;
}) {
  async function requireAdmin() {
    const actor = requireUser(input.actor);
    const rows = await input.database
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(
        and(
          eq(members.workspaceId, input.workspaceId),
          eq(members.userId, actor.id),
          or(eq(members.role, "owner"), eq(members.role, "admin")),
        ),
      )
      .limit(2);
    const row = rows[0];
    if (rows.length !== 1 || !row) {
      throw createGraphQLError(
        "FORBIDDEN",
        "Webhook administration requires an administrator role.",
      );
    }
    return { actor, role: row.role };
  }

  async function audit(
    transaction: TransactionDatabase,
    action: string,
    resourceId: string,
    outcome = "success",
  ): Promise<string> {
    const id = newId();
    await transaction.insert(auditEvents).values({
      id,
      workspaceId: input.workspaceId,
      actorUserId: input.actor.type === "user" ? input.actor.id : null,
      sessionId: input.actor.type === "user" ? input.actor.sessionId : null,
      apiKeyId: input.actor.type === "apiKey" ? input.actor.id : null,
      action,
      resourceKind: "webhook",
      resourceId,
      requestId: input.requestId,
      outcome,
      redactedDiff: null,
    });
    return id;
  }

  function idempotencyContext(
    actor: Extract<GraphQLActor, { type: "user" }>,
  ): ResearchServiceContext {
    const secret = input.idempotencyHmacKey;
    if (!secret) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Idempotent webhook administration is not configured.",
      );
    }
    return {
      actor,
      database: input.database,
      idempotencyHmacKey: secret,
      permissions: input.permissions,
      requestId: input.requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.workspaceId,
    };
  }

  async function replayWebhookMutation(
    reference: Readonly<Record<string, string | number | boolean | null>>,
    options: {
      action: "webhook.create" | "webhook.disable" | "webhook.rotate";
      state: "active" | "disabled";
    },
  ): Promise<{
    code: "APPLIED" | "INVALID";
    id: string | null;
    requestId: string;
    version: number | null;
  }> {
    const auditEventId = reference.auditEventId;
    const requestId = reference.requestId;
    const version = reference.version;
    const webhookId = reference.webhookId;
    if (
      Object.keys(reference).sort().join(":") !==
        "auditEventId:code:requestId:version:webhookId" ||
      typeof requestId !== "string" ||
      !WEBHOOK_REFERENCE_UUID.test(requestId) ||
      (reference.code !== "APPLIED" && reference.code !== "INVALID") ||
      (reference.code === "APPLIED" &&
        (typeof auditEventId !== "string" ||
          !WEBHOOK_REFERENCE_UUID.test(auditEventId) ||
          typeof version !== "number" ||
          !Number.isSafeInteger(version) ||
          version < 1 ||
          typeof webhookId !== "string" ||
          !WEBHOOK_REFERENCE_UUID.test(webhookId))) ||
      (reference.code === "INVALID" &&
        (auditEventId !== null || version !== null || webhookId !== null))
    ) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    if (reference.code === "INVALID") {
      return { code: "INVALID", id: null, requestId, version: null };
    }
    return input.database.transaction(async (transaction) => {
      const [webhook] = await transaction
        .select({
          deletedAt: webhooks.deletedAt,
          id: webhooks.id,
          state: webhooks.state,
          version: webhooks.version,
        })
        .from(webhooks)
        .where(
          and(
            eq(webhooks.workspaceId, input.workspaceId),
            eq(webhooks.id, webhookId as string),
            eq(webhooks.state, options.state),
            options.state === "active" ? isNull(webhooks.deletedAt) : undefined,
          ),
        )
        .limit(1)
        .for("share");
      if (!webhook) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      }
      if (options.state === "disabled" && webhook.deletedAt == null) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      if (webhook.version !== version) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation response is no longer current.",
        );
      }
      const [auditEvent] = await transaction
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, input.workspaceId),
            eq(auditEvents.id, auditEventId as string),
            eq(auditEvents.actorUserId, requireUser(input.actor).id),
            eq(auditEvents.action, options.action),
            eq(auditEvents.resourceKind, "webhook"),
            eq(auditEvents.resourceId, webhookId as string),
            eq(auditEvents.requestId, requestId),
            eq(auditEvents.outcome, "success"),
            isNull(auditEvents.redactedDiff),
          ),
        )
        .limit(1);
      if (!auditEvent) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      return {
        code: "APPLIED" as const,
        id: webhook.id,
        requestId,
        version: version as number,
      };
    });
  }

  return {
    async list(): Promise<readonly SafeWebhook[]> {
      await requireAdmin();
      const rows = await input.database
        .select()
        .from(webhooks)
        .where(
          and(
            eq(webhooks.workspaceId, input.workspaceId),
            isNull(webhooks.deletedAt),
          ),
        )
        .orderBy(asc(webhooks.url), asc(webhooks.id));
      return rows.map(mapWebhook);
    },
    async create(
      urlValue: string,
      eventsValue: readonly string[],
      idempotencyKey?: string | null,
    ): Promise<WebhookMutationResult> {
      await requireAdmin();
      const url = normalizeUrl(urlValue);
      const subscribedEvents = normalizeEvents(eventsValue);
      const actor = requireUser(input.actor);
      const run = async (database: Database) => {
        const id = newId();
        const secret = createSecret();
        const fingerprint = createHash("sha256")
          .update(secret, "utf8")
          .digest("hex");
        await database.insert(webhooks).values({
          id,
          workspaceId: input.workspaceId,
          url,
          encryptedSecret: sealEnvelope({
            key: input.encryptionKey,
            plaintext: secret,
            purpose: "webhook-secret",
          }),
          secretFingerprint: fingerprint,
          subscribedEvents: [...subscribedEvents],
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        const auditEventId = await audit(
          database as unknown as TransactionDatabase,
          "webhook.create",
          id,
        );
        return {
          reference: {
            auditEventId,
            code: "APPLIED" as const,
            requestId: input.requestId,
            version: 1,
            webhookId: id,
          },
          secret,
        };
      };
      if (idempotencyKey == null) {
        const result = await input.database.transaction((transaction) =>
          run(transaction as unknown as Database),
        );
        return {
          id: result.reference.webhookId,
          code: "APPLIED",
          replayed: false,
          requestId: result.reference.requestId,
          secret: result.secret,
        };
      }
      const context = idempotencyContext(actor);
      const derived = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS),
        idempotencyKey,
        operation: "webhook.create.graphql",
        requestMaterial: { subscribedEvents, url },
        secret: input.idempotencyHmacKey!,
      });
      let transientSecret: string | undefined;
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        derived,
        ["webhook:create"],
        async (scopedContext) => {
          const result = await run(scopedContext.database);
          transientSecret = result.secret;
          return result.reference;
        },
      );
      await input.runtime?.afterIdempotentCommit?.("webhook.create");
      const response = executed.replayed
        ? await replayWebhookMutation(executed.responseReference, {
            action: "webhook.create",
            state: "active",
          })
        : {
            code: "APPLIED" as const,
            id: executed.responseReference.webhookId as string,
            requestId: executed.responseReference.requestId as string,
            version: executed.responseReference.version as number,
          };
      return {
        id: response.id,
        code: response.code,
        replayed: executed.replayed,
        requestId: response.requestId,
        ...(!executed.replayed && transientSecret
          ? { secret: transientSecret }
          : {}),
      };
    },
    async rotate(
      id: string,
      expectedVersion?: number | null,
      idempotencyKey?: string | null,
    ): Promise<WebhookMutationResult> {
      await requireAdmin();
      if (!UUID.test(id))
        return { id: null, code: "INVALID", requestId: input.requestId };
      if (
        expectedVersion != null &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The webhook version is invalid.",
        );
      }
      if (idempotencyKey != null && expectedVersion == null) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An expected webhook version is required for idempotent rotation.",
        );
      }
      const actor = requireUser(input.actor);
      const run = async (database: Database) => {
        const [current] = await database
          .select({ id: webhooks.id, version: webhooks.version })
          .from(webhooks)
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              eq(webhooks.state, "active"),
              isNull(webhooks.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) {
          return {
            reference: {
              auditEventId: null,
              code: "INVALID" as const,
              requestId: input.requestId,
              version: null,
              webhookId: null,
            },
          };
        }
        if (expectedVersion != null && current.version !== expectedVersion) {
          throw createGraphQLError(
            "CONFLICT",
            "The webhook has changed since it was read.",
          );
        }
        const secret = createSecret();
        const fingerprint = createHash("sha256")
          .update(secret, "utf8")
          .digest("hex");
        const [updated] = await database
          .update(webhooks)
          .set({
            encryptedSecret: sealEnvelope({
              key: input.encryptionKey,
              plaintext: secret,
              purpose: "webhook-secret",
            }),
            secretFingerprint: fingerprint,
            version: sql`${webhooks.version} + 1`,
            updatedAt: new Date(),
            updatedBy: actor.id,
          })
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              eq(webhooks.state, "active"),
              eq(webhooks.version, current.version),
              isNull(webhooks.deletedAt),
            ),
          )
          .returning({ id: webhooks.id, version: webhooks.version });
        if (!updated) {
          throw createGraphQLError(
            "CONFLICT",
            "The webhook has changed since it was read.",
          );
        }
        const auditEventId = await audit(
          database as unknown as TransactionDatabase,
          "webhook.rotate",
          id,
        );
        return {
          reference: {
            auditEventId,
            code: "APPLIED" as const,
            requestId: input.requestId,
            version: updated.version,
            webhookId: updated.id,
          },
          secret,
        };
      };
      if (idempotencyKey == null) {
        const result = await input.database.transaction((transaction) =>
          run(transaction as unknown as Database),
        );
        return {
          id: result.reference.webhookId,
          code: result.reference.code,
          replayed: false,
          requestId: result.reference.requestId,
          ...(result.secret ? { secret: result.secret } : {}),
        };
      }
      const context = idempotencyContext(actor);
      const derived = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS),
        idempotencyKey,
        operation: "webhook.rotate.graphql",
        requestMaterial: { expectedVersion: expectedVersion!, webhookId: id },
        secret: input.idempotencyHmacKey!,
      });
      let transientSecret: string | undefined;
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        derived,
        ["webhook:update"],
        async (scopedContext) => {
          const result = await run(scopedContext.database);
          transientSecret = result.secret;
          return result.reference;
        },
      );
      await input.runtime?.afterIdempotentCommit?.("webhook.rotate");
      const response = executed.replayed
        ? await replayWebhookMutation(executed.responseReference, {
            action: "webhook.rotate",
            state: "active",
          })
        : {
            code: executed.responseReference.code as "APPLIED" | "INVALID",
            id:
              typeof executed.responseReference.webhookId === "string"
                ? executed.responseReference.webhookId
                : null,
            requestId: executed.responseReference.requestId as string,
            version:
              typeof executed.responseReference.version === "number"
                ? executed.responseReference.version
                : null,
          };
      return {
        id: response.id,
        code: response.code,
        replayed: executed.replayed,
        requestId: response.requestId,
        ...(!executed.replayed && transientSecret
          ? { secret: transientSecret }
          : {}),
      };
    },
    async disable(
      id: string,
      expectedVersion?: number | null,
      idempotencyKey?: string | null,
    ): Promise<WebhookMutationResult> {
      await requireAdmin();
      if (!UUID.test(id))
        return { id: null, code: "INVALID", requestId: input.requestId };
      if (
        expectedVersion != null &&
        (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The webhook version is invalid.",
        );
      }
      if (idempotencyKey != null && expectedVersion == null) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "An expected webhook version is required for idempotent disable.",
        );
      }
      const actor = requireUser(input.actor);
      const run = async (database: Database) => {
        const [current] = await database
          .select({ id: webhooks.id, version: webhooks.version })
          .from(webhooks)
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              isNull(webhooks.deletedAt),
            ),
          )
          .limit(1)
          .for("update");
        if (!current) {
          return {
            auditEventId: null,
            code: "INVALID" as const,
            requestId: input.requestId,
            version: null,
            webhookId: null,
          };
        }
        if (expectedVersion != null && current.version !== expectedVersion) {
          throw createGraphQLError(
            "CONFLICT",
            "The webhook has changed since it was read.",
          );
        }
        const [updated] = await database
          .update(webhooks)
          .set({
            state: "disabled",
            deletedAt: new Date(),
            deletedBy: actor.id,
            version: sql`${webhooks.version} + 1`,
            updatedAt: new Date(),
            updatedBy: actor.id,
          })
          .where(
            and(
              eq(webhooks.id, id),
              eq(webhooks.workspaceId, input.workspaceId),
              eq(webhooks.version, current.version),
              isNull(webhooks.deletedAt),
            ),
          )
          .returning({ id: webhooks.id, version: webhooks.version });
        if (!updated) {
          throw createGraphQLError(
            "CONFLICT",
            "The webhook has changed since it was read.",
          );
        }
        const auditEventId = await audit(
          database as unknown as TransactionDatabase,
          "webhook.disable",
          id,
        );
        return {
          auditEventId,
          code: "APPLIED" as const,
          requestId: input.requestId,
          version: updated.version,
          webhookId: updated.id,
        };
      };
      if (idempotencyKey == null) {
        const response = await input.database.transaction((transaction) =>
          run(transaction as unknown as Database),
        );
        return {
          id: response.webhookId,
          code: response.code,
          replayed: false,
          requestId: response.requestId,
        };
      }
      const context = idempotencyContext(actor);
      const derived = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS),
        idempotencyKey,
        operation: "webhook.disable.graphql",
        requestMaterial: { expectedVersion: expectedVersion!, webhookId: id },
        secret: input.idempotencyHmacKey!,
      });
      const executed = await runPrincipalIdempotentResearchWrite(
        context,
        derived,
        ["webhook:delete"],
        async (scopedContext) => run(scopedContext.database),
      );
      await input.runtime?.afterIdempotentCommit?.("webhook.disable");
      const response = executed.replayed
        ? await replayWebhookMutation(executed.responseReference, {
            action: "webhook.disable",
            state: "disabled",
          })
        : {
            code: executed.responseReference.code as "APPLIED" | "INVALID",
            id:
              typeof executed.responseReference.webhookId === "string"
                ? executed.responseReference.webhookId
                : null,
            requestId: executed.responseReference.requestId as string,
            version:
              typeof executed.responseReference.version === "number"
                ? executed.responseReference.version
                : null,
          };
      return {
        id: response.id,
        code: response.code,
        replayed: executed.replayed,
        requestId: response.requestId,
      };
    },
    async enqueueEvent(
      event: string,
      payload: Record<string, unknown>,
      options: { webhookId?: string } = {},
    ): Promise<readonly string[]> {
      return input.database.transaction((transaction) =>
        enqueueEventInDatabase(
          transaction as unknown as Database,
          event,
          payload,
          options,
        ),
      );
    },
    async sendTestEvent(
      webhookId: string,
      idempotencyKey?: string | null,
    ): Promise<WebhookMutationResult> {
      await requireAdmin();
      const run = async (database: Database) => {
        const deliveryIds = await enqueueEventInDatabase(
          database,
          "webhook.test",
          { message: "Humans webhook test" },
          { webhookId },
        );
        const deliveryId = deliveryIds[0] ?? null;
        if (!deliveryId) {
          throw createGraphQLError(
            "NOT_FOUND",
            "The webhook is disabled or not subscribed to webhook.test.",
          );
        }
        return { webhookId, deliveryId };
      };
      if (idempotencyKey == null) {
        const result = await input.database.transaction((transaction) =>
          run(transaction as unknown as Database),
        );
        return {
          id: result.webhookId,
          deliveryId: result.deliveryId,
          code: "APPLIED",
          requestId: input.requestId,
        };
      }
      const secret = input.idempotencyHmacKey;
      if (!secret) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Idempotent webhook delivery is not configured.",
        );
      }
      const actor = requireUser(input.actor);
      const context: ResearchServiceContext = {
        actor,
        database: input.database,
        idempotencyHmacKey: secret,
        permissions: input.permissions,
        requestId: input.requestId,
        searchIndexMaintenance: input.searchIndexMaintenance,
        workspaceId: input.workspaceId,
      };
      const derived = deriveResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + WEBHOOK_IDEMPOTENCY_TTL_MS),
        idempotencyKey,
        operation: "webhook.test-event.send",
        requestMaterial: { webhookId },
        secret,
      });
      const result = await runIdempotentResearchWrite(
        context,
        derived,
        ["webhook:update"],
        async (scopedContext) => run(scopedContext.database),
      );
      const responseWebhookId = result.responseReference.webhookId;
      const responseDeliveryId = result.responseReference.deliveryId;
      if (
        typeof responseWebhookId !== "string" ||
        !WEBHOOK_REFERENCE_UUID.test(responseWebhookId) ||
        typeof responseDeliveryId !== "string" ||
        !WEBHOOK_REFERENCE_UUID.test(responseDeliveryId)
      ) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      if (responseWebhookId !== webhookId) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      const [delivery] = await input.database
        .select({ id: webhookDeliveries.id })
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.workspaceId, input.workspaceId),
            eq(webhookDeliveries.webhookId, responseWebhookId),
            eq(webhookDeliveries.id, responseDeliveryId),
          ),
        )
        .limit(1);
      if (!delivery) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The operation response reference is invalid.",
        );
      }
      return {
        id: responseWebhookId,
        deliveryId: responseDeliveryId,
        code: "APPLIED",
        requestId: input.requestId,
      };
    },
  };

  async function enqueueEventInDatabase(
    database: Database,
    event: string,
    payload: Record<string, unknown>,
    options: { webhookId?: string } = {},
  ): Promise<readonly string[]> {
    const actor = input.actor.type === "user" ? input.actor : null;
    if (!EVENT_NAME.test(event)) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "Webhook event payload is invalid.",
      );
    }
    const rows = await database
      .select()
      .from(webhooks)
      .where(
        and(
          eq(webhooks.workspaceId, input.workspaceId),
          eq(webhooks.state, "active"),
          isNull(webhooks.deletedAt),
          ...(options.webhookId ? [eq(webhooks.id, options.webhookId)] : []),
        ),
      );
    const payloadText = JSON.stringify({
      data: payload,
      event,
      id: newId(),
      occurredAt: new Date().toISOString(),
    });
    if (Buffer.byteLength(payloadText, "utf8") > 64 * 1024) {
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "Webhook event payload is invalid.",
      );
    }
    const eventId = JSON.parse(payloadText).id as string;
    const deliveries: string[] = [];
    const scopedJobs = createJobsService({
      database,
      encryptionKey: input.encryptionKey,
    });
    for (const webhook of rows.filter((row) =>
      row.subscribedEvents.includes(event),
    )) {
      const deliveryId = newId();
      await database.insert(webhookDeliveries).values({
        id: deliveryId,
        workspaceId: input.workspaceId,
        webhookId: webhook.id,
        eventId,
        encryptedPayload: sealEnvelope({
          key: input.encryptionKey,
          plaintext: payloadText,
          purpose: "webhook-payload",
        }),
        payloadHash: webhookPayloadHash(payloadText),
        attempt: 1,
        signatureAlgorithm: "hmac-sha256",
      });
      await scopedJobs.enqueue({
        createdBy: actor?.id ?? null,
        principalId: actor ? null : undefined,
        idempotencyKey: `webhook:${deliveryId}:1`,
        payload: {
          kind: "webhook_delivery",
          deliveryId,
          webhookId: webhook.id,
        },
        workspaceId: input.workspaceId,
      });
      deliveries.push(deliveryId);
    }
    return deliveries;
  }
}
