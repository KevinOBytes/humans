import { createHmac } from "node:crypto";

import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { apiKeys, members, sessions } from "@/db/schema/auth";
import { importRows, imports } from "@/db/schema/files";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { idempotencyKeys, jobs } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaces } from "@/db/schema/workspaces";
import { createGraphQLError } from "@/graphql/errors";
import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  isWorkspaceRole,
  parseApiKeyPermissionKeys,
  parsePermissionKey,
  rolePermissionKeys,
  type PermissionKey,
} from "@/modules/auth/permissions";
import { decodeJobPayload } from "@/modules/jobs/service";
import { JobExecutionError } from "@/modules/jobs/types";
import {
  SEARCH_INDEX_SOURCE_KINDS,
  type SearchIndexMaintenance,
  type SearchIndexMutation,
} from "@/modules/search/index-maintenance";

import type { ResearchServiceContext } from "./service";

export type ResearchResponseReference = Readonly<
  Record<string, string | number | boolean | null>
>;

export type CanonicalRequestMaterial =
  | boolean
  | null
  | number
  | string
  | readonly CanonicalRequestMaterial[]
  | CanonicalRequestObject;

export interface CanonicalRequestObject {
  readonly [key: string]: CanonicalRequestMaterial;
}

declare const derivedResearchIdempotencyBrand: unique symbol;

export type DerivedResearchIdempotency = Readonly<{
  [derivedResearchIdempotencyBrand]: true;
}>;

export type ResearchIdempotencyClaim = Readonly<{
  claimId: string;
  responseReference: ResearchResponseReference | null;
  state: "new" | "pending" | "completed";
}>;

type InternalDerivedResearchIdempotency = DerivedResearchIdempotency & {
  readonly actorId: string;
  readonly expiresAtMs: number;
  readonly keyHash: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly workspaceId: string;
};

declare const derivedPrincipalIdempotencyBrand: unique symbol;
export type DerivedPrincipalIdempotency = Readonly<{
  [derivedPrincipalIdempotencyBrand]: true;
}>;
type InternalDerivedPrincipalIdempotency = DerivedPrincipalIdempotency & {
  readonly actorPrincipalId: string;
  readonly expiresAtMs: number;
  readonly keyHash: string;
  readonly operation: string;
  readonly requestHash: string;
  readonly workspaceId: string;
};

const callerOwnedDatabases = new WeakSet<object>();
const retiredTransactionDatabases = new WeakSet<object>();
const derivedIdempotencyInputs = new WeakMap<
  object,
  InternalDerivedResearchIdempotency
>();
const derivedPrincipalIdempotencyInputs = new WeakMap<
  object,
  InternalDerivedPrincipalIdempotency
>();
type TrustedWorkerAuditContext = {
  readonly database: Database;
  readonly fencingToken: number;
  readonly importId: string;
  readonly importRowId: string;
  readonly jobId: string;
  readonly leaseExpiresAt: string;
  readonly leaseOwner: string;
  readonly memberId: string;
  readonly operation: ImportRowOperation;
  readonly permissions: ReadonlySet<PermissionKey>;
  readonly principalId: string;
  readonly requestId: string;
  readonly role: string;
  readonly searchIndexMaintenance: SearchIndexMaintenance;
  readonly userId: string;
  readonly workspaceId: string;
};
const trustedWorkerAuditContexts = new WeakMap<
  ResearchServiceContext,
  TrustedWorkerAuditContext
>();
const IDEMPOTENCY_OPERATION = /^[a-z][a-z0-9._:-]{0,127}$/u;
const RESPONSE_REFERENCE_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const HMAC_SECRET = /^[0-9a-f]{64}$/iu;
const MAX_IDEMPOTENCY_KEY_BYTES = 128;
const MAX_CANONICAL_REQUEST_BYTES = 65_536;
const MAX_CANONICAL_DEPTH = 16;
const MAX_CANONICAL_NODES = 4_096;
const WORKER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ENCRYPTION_KEY = /^[0-9a-f]{64}$/iu;
const importRowPermissionBundles = {
  PERSON: ["person:create", "person:read", "fact:create"],
  RELATIONSHIP: ["relationship:create", "person:read"],
} as const satisfies Record<string, readonly PermissionKey[]>;
type ImportRowOperation = keyof typeof importRowPermissionBundles;

class ImmutablePermissionSet implements ReadonlySet<PermissionKey> {
  readonly #values: ReadonlySet<PermissionKey>;

  constructor(values: readonly PermissionKey[]) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: PermissionKey): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[PermissionKey, PermissionKey]> {
    return this.#values.entries();
  }

  keys(): SetIterator<PermissionKey> {
    return this.#values.keys();
  }

  values(): SetIterator<PermissionKey> {
    return this.#values.values();
  }

  forEach(
    callbackfn: (
      value: PermissionKey,
      value2: PermissionKey,
      set: ReadonlySet<PermissionKey>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  [Symbol.iterator](): SetIterator<PermissionKey> {
    return this.#values[Symbol.iterator]();
  }

  union<U>(other: ReadonlySetLike<U>): Set<PermissionKey | U> {
    return new Set(this.#values).union(other);
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<PermissionKey & U> {
    return new Set(this.#values).intersection(other);
  }

  difference<U>(other: ReadonlySetLike<U>): Set<PermissionKey> {
    return new Set(this.#values).difference(other);
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<PermissionKey | U> {
    return new Set(this.#values).symmetricDifference(other);
  }

  isSubsetOf(other: ReadonlySetLike<unknown>): boolean {
    return new Set(this.#values).isSubsetOf(other);
  }

  isSupersetOf(other: ReadonlySetLike<unknown>): boolean {
    return new Set(this.#values).isSupersetOf(other);
  }

  isDisjointFrom(other: ReadonlySetLike<unknown>): boolean {
    return new Set(this.#values).isDisjointFrom(other);
  }
}

function forbidden(): never {
  throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

function invalidIdempotency(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The idempotent operation metadata is invalid.",
  );
}

function unavailableTransaction(): never {
  throw createGraphQLError(
    "PRECONDITION_FAILED",
    "The research transaction context is no longer active.",
  );
}

function retryableLeaseLoss(): never {
  throw new JobExecutionError("lease_lost", "retryable");
}

/** Read-only audit lookup; only this module can confer or retire worker trust. */
export function getTrustedWorkerAuditContext(
  context: ResearchServiceContext,
): TrustedWorkerAuditContext | null {
  if (context.actor.type !== "worker") return null;
  const metadata = trustedWorkerAuditContexts.get(context);
  return metadata &&
    callerOwnedDatabases.has(context.database) &&
    metadata.database === context.database &&
    metadata.permissions === context.permissions &&
    metadata.workspaceId === context.workspaceId &&
    metadata.requestId === context.requestId &&
    metadata.userId === context.actor.id &&
    metadata.memberId === context.actor.memberId &&
    metadata.principalId === context.actor.principalId &&
    metadata.role === context.actor.role &&
    metadata.importId === context.actor.importId &&
    metadata.importRowId === context.actor.importRowId &&
    metadata.jobId === context.actor.jobId &&
    metadata.leaseExpiresAt === context.actor.leaseExpiresAt &&
    metadata.leaseOwner === context.actor.leaseOwner &&
    metadata.fencingToken === context.actor.fencingToken &&
    metadata.operation === context.actor.operation &&
    metadata.searchIndexMaintenance === context.searchIndexMaintenance
    ? metadata
    : null;
}

function requireResearchPermissions(
  context: ResearchServiceContext,
  requiredPermissions: readonly string[],
): readonly PermissionKey[] {
  if (
    (context.actor.type !== "user" && context.actor.type !== "apiKey") ||
    (context.actor.type === "user" && !isWorkspaceRole(context.actor.role)) ||
    requiredPermissions.length === 0 ||
    requiredPermissions.length > 32 ||
    new Set(requiredPermissions).size !== requiredPermissions.length
  ) {
    return forbidden();
  }
  const canonical = requiredPermissions.map((permission) =>
    parsePermissionKey(permission),
  );
  if (canonical.some((permission) => permission === undefined)) {
    return forbidden();
  }
  const keys = canonical.map((permission) => permission!.key);
  const claimedPermissions =
    context.actor.type === "user" && isWorkspaceRole(context.actor.role)
      ? rolePermissionKeys(context.actor.role)
      : context.permissions;
  if (keys.some((permission) => !claimedPermissions.has(permission))) {
    return forbidden();
  }
  return keys;
}

async function requireLiveResearchIdentity(
  database: Database,
  context: ResearchServiceContext & { actor: { type: "user" } },
  requiredPermissions: readonly PermissionKey[],
): Promise<void> {
  const rows = await database
    .select({ role: members.role })
    .from(sessions)
    .innerJoin(
      members,
      and(
        eq(members.id, context.actor.memberId),
        eq(members.userId, sessions.userId),
        eq(members.workspaceId, context.workspaceId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, members.workspaceId),
        eq(workspaces.organizationId, members.organizationId),
        eq(workspaces.organizationId, sessions.activeOrganizationId),
      ),
    )
    .innerJoin(
      workspacePrincipals,
      // memberIdSnapshot records the membership that created this durable
      // principal. A later valid re-invitation has a different current member.
      and(
        eq(workspacePrincipals.id, context.actor.principalId),
        eq(workspacePrincipals.workspaceId, context.workspaceId),
        eq(workspacePrincipals.principalType, "user"),
        eq(workspacePrincipals.userId, context.actor.id),
      ),
    )
    .where(
      and(
        eq(sessions.id, context.actor.sessionId),
        eq(sessions.userId, context.actor.id),
        gt(sessions.expiresAt, new Date()),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(2)
    .for("share", {
      of: [sessions, members, workspaces, workspacePrincipals],
    });
  const live = rows[0];
  if (
    rows.length !== 1 ||
    !live ||
    !isWorkspaceRole(live.role) ||
    live.role !== context.actor.role
  ) {
    return forbidden();
  }
  const livePermissions = rolePermissionKeys(live.role);
  if (
    requiredPermissions.some((permission) => !livePermissions.has(permission))
  ) {
    return forbidden();
  }
}

async function requireLiveApiKeyIdentity(
  database: Database,
  context: ResearchServiceContext & { actor: { type: "apiKey" } },
  requiredPermissions: readonly PermissionKey[],
): Promise<void> {
  const rows = await database
    .select({ permissions: apiKeys.permissions })
    .from(apiKeys)
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, apiKeys.workspaceId),
        eq(workspaces.organizationId, apiKeys.referenceId),
      ),
    )
    .innerJoin(
      workspacePrincipals,
      and(
        eq(workspacePrincipals.id, context.actor.principalId),
        eq(workspacePrincipals.workspaceId, context.workspaceId),
        eq(workspacePrincipals.principalType, "api_key"),
        eq(workspacePrincipals.apiKeyId, context.actor.id),
      ),
    )
    .where(
      and(
        eq(apiKeys.id, context.actor.id),
        eq(apiKeys.workspaceId, context.workspaceId),
        eq(apiKeys.configId, "organization"),
        eq(apiKeys.enabled, true),
        or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, new Date())),
        eq(workspaces.state, "active"),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(2)
    .for("share");
  const live = rows[0];
  if (rows.length !== 1 || !live) return forbidden();
  const livePermissions = parseApiKeyPermissionKeys(live.permissions);
  if (
    requiredPermissions.some((permission) => !livePermissions.has(permission))
  ) {
    return forbidden();
  }
}

function canonicalizeRequestMaterial(
  value: CanonicalRequestMaterial,
  depth: number,
  state: { nodes: number },
): string {
  state.nodes += 1;
  if (depth > MAX_CANONICAL_DEPTH || state.nodes > MAX_CANONICAL_NODES) {
    return invalidIdempotency();
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return invalidIdempotency();
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      value.length > MAX_CANONICAL_NODES ||
      ownKeys.some((key) => typeof key === "symbol") ||
      ownKeys.length !== value.length + 1 ||
      Object.keys(value).length !== value.length ||
      Array.from({ length: value.length }, (_item, index) => index).some(
        (index) => {
          const descriptor = descriptors[String(index)];
          return !descriptor?.enumerable || !("value" in descriptor);
        },
      )
    ) {
      return invalidIdempotency();
    }
    return `[${value
      .map((item) => canonicalizeRequestMaterial(item, depth + 1, state))
      .join(",")}]`;
  }
  if (typeof value !== "object") return invalidIdempotency();
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  const enumerableKeys = Object.keys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.some((key) => typeof key !== "string") ||
    ownKeys.length !== enumerableKeys.length ||
    enumerableKeys.some((key) => {
      const descriptor = descriptors[key];
      return !descriptor?.enumerable || !("value" in descriptor);
    })
  ) {
    return invalidIdempotency();
  }
  const record = value as Readonly<Record<string, CanonicalRequestMaterial>>;
  return `{${enumerableKeys
    .sort()
    .map((key) => {
      const item = record[key];
      if (item === undefined) return invalidIdempotency();
      return `${JSON.stringify(key)}:${canonicalizeRequestMaterial(
        item,
        depth + 1,
        state,
      )}`;
    })
    .join(",")}}`;
}

function hmac(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`humans:${purpose}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function deriveResearchIdempotency(
  context: ResearchServiceContext,
  input: {
    expiresAt: Date;
    idempotencyKey: string;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
    secret: string;
  },
): DerivedResearchIdempotency {
  if (context.actor.type !== "user") return forbidden();
  const normalizedKey =
    typeof input.idempotencyKey === "string"
      ? input.idempotencyKey.normalize("NFKC").trim()
      : "";
  const keyBytes = Buffer.byteLength(normalizedKey, "utf8");
  const expiresAtMs = input.expiresAt?.getTime?.() ?? Number.NaN;
  if (
    !IDEMPOTENCY_OPERATION.test(input.operation) ||
    !HMAC_SECRET.test(input.secret) ||
    keyBytes === 0 ||
    keyBytes > MAX_IDEMPOTENCY_KEY_BYTES ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    input.requestMaterial == null ||
    typeof input.requestMaterial !== "object" ||
    Array.isArray(input.requestMaterial)
  ) {
    return invalidIdempotency();
  }
  const requestMaterial = canonicalizeRequestMaterial(
    input.requestMaterial,
    0,
    {
      nodes: 0,
    },
  );
  if (
    Buffer.byteLength(requestMaterial, "utf8") > MAX_CANONICAL_REQUEST_BYTES
  ) {
    return invalidIdempotency();
  }
  const actorMaterial = canonicalizeRequestMaterial(
    {
      memberId: context.actor.memberId,
      principalId: context.actor.principalId,
      userId: context.actor.id,
      workspaceId: context.workspaceId,
    },
    0,
    { nodes: 0 },
  );
  const metadata: InternalDerivedResearchIdempotency = Object.freeze({
    actorId: context.actor.id,
    expiresAtMs,
    keyHash: hmac(
      input.secret,
      "idempotency-key",
      `${actorMaterial}\0${input.operation}\0${normalizedKey}`,
    ),
    operation: input.operation,
    requestHash: hmac(
      input.secret,
      "idempotency-request",
      `${actorMaterial}\0${input.operation}\0${requestMaterial}`,
    ),
    workspaceId: context.workspaceId,
  }) as InternalDerivedResearchIdempotency;
  const handle = Object.freeze({}) as DerivedResearchIdempotency;
  derivedIdempotencyInputs.set(handle, metadata);
  return handle;
}

/** Derives an opaque claim for user and API-key research mutations. The raw
 * key and canonical request material never leave process memory. */
export function derivePrincipalResearchIdempotency(
  context: ResearchServiceContext,
  input: {
    expiresAt: Date;
    idempotencyKey: string;
    operation: string;
    requestMaterial: Readonly<Record<string, CanonicalRequestMaterial>>;
    secret: string;
  },
): DerivedPrincipalIdempotency {
  if (context.actor.type !== "user" && context.actor.type !== "apiKey") {
    return forbidden();
  }
  const normalizedKey =
    typeof input.idempotencyKey === "string"
      ? input.idempotencyKey.normalize("NFKC").trim()
      : "";
  const expiresAtMs = input.expiresAt?.getTime?.() ?? Number.NaN;
  if (
    !IDEMPOTENCY_OPERATION.test(input.operation) ||
    !HMAC_SECRET.test(input.secret) ||
    Buffer.byteLength(normalizedKey, "utf8") < 1 ||
    Buffer.byteLength(normalizedKey, "utf8") > MAX_IDEMPOTENCY_KEY_BYTES ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= Date.now() ||
    input.requestMaterial == null ||
    typeof input.requestMaterial !== "object" ||
    Array.isArray(input.requestMaterial)
  ) {
    return invalidIdempotency();
  }
  const requestMaterial = canonicalizeRequestMaterial(
    input.requestMaterial,
    0,
    { nodes: 0 },
  );
  if (
    Buffer.byteLength(requestMaterial, "utf8") > MAX_CANONICAL_REQUEST_BYTES
  ) {
    return invalidIdempotency();
  }
  const actorMaterial = canonicalizeRequestMaterial(
    {
      principalId: context.actor.principalId,
      principalType: context.actor.type,
      workspaceId: context.workspaceId,
    },
    0,
    { nodes: 0 },
  );
  const metadata = Object.freeze({
    actorPrincipalId: context.actor.principalId,
    expiresAtMs,
    keyHash: hmac(
      input.secret,
      "principal-idempotency-key",
      `${actorMaterial}\0${input.operation}\0${normalizedKey}`,
    ),
    operation: input.operation,
    requestHash: hmac(
      input.secret,
      "principal-idempotency-request",
      `${actorMaterial}\0${input.operation}\0${requestMaterial}`,
    ),
    workspaceId: context.workspaceId,
  }) as InternalDerivedPrincipalIdempotency;
  const handle = Object.freeze({}) as DerivedPrincipalIdempotency;
  derivedPrincipalIdempotencyInputs.set(handle, metadata);
  return handle;
}

function validateResponseReference(value: unknown): ResearchResponseReference {
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The operation response reference is invalid.",
    );
  }
  const entries = Object.entries(value);
  if (
    entries.length > 16 ||
    entries.some(
      ([key, item]) =>
        !RESPONSE_REFERENCE_KEY.test(key) ||
        !(
          item === null ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)) ||
          (typeof item === "string" && item.length <= 512)
        ),
    )
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The operation response reference is invalid.",
    );
  }
  return Object.fromEntries(entries) as ResearchResponseReference;
}

/**
 * Claims a durable idempotency row without holding a PostgreSQL transaction
 * across an external provider call. A pending claim is intentionally
 * replayable by a concurrent caller after the domain mutation's row lock
 * settles; request-hash mismatches still fail before any domain work.
 */
export async function claimIdempotentResearchWrite(
  context: ResearchServiceContext,
  input: DerivedResearchIdempotency,
  requiredPermissions: readonly string[],
): Promise<ResearchIdempotencyClaim> {
  if (context.actor.type !== "user") return forbidden();
  const metadata = derivedIdempotencyInputs.get(input as object);
  const now = new Date();
  if (
    !metadata ||
    metadata.actorId !== context.actor.id ||
    metadata.workspaceId !== context.workspaceId ||
    metadata.expiresAtMs <= now.getTime()
  ) {
    return invalidIdempotency();
  }
  return runResearchTransaction(
    context,
    { requiredPermissions },
    async (scopedContext) => {
      const identity = and(
        eq(idempotencyKeys.workspaceId, scopedContext.workspaceId),
        eq(idempotencyKeys.actorId, scopedContext.actor.id),
        eq(idempotencyKeys.operation, metadata.operation),
        eq(idempotencyKeys.keyHash, metadata.keyHash),
      );
      await scopedContext.database
        .delete(idempotencyKeys)
        .where(and(identity, lte(idempotencyKeys.expiresAt, now)));
      const [inserted] = await scopedContext.database
        .insert(idempotencyKeys)
        .values({
          id: newId(),
          workspaceId: scopedContext.workspaceId,
          actorId: scopedContext.actor.id,
          operation: metadata.operation,
          keyHash: metadata.keyHash,
          requestHash: metadata.requestHash,
          status: "pending",
          expiresAt: new Date(metadata.expiresAtMs),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            idempotencyKeys.workspaceId,
            idempotencyKeys.actorId,
            idempotencyKeys.operation,
            idempotencyKeys.keyHash,
          ],
        })
        .returning({ id: idempotencyKeys.id });
      const [claim] = await scopedContext.database
        .select()
        .from(idempotencyKeys)
        .where(identity)
        .for("update");
      if (!claim) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation could not be claimed.",
        );
      }
      if (claim.requestHash !== metadata.requestHash) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotency key is already bound to another request.",
        );
      }
      if (inserted) {
        return { claimId: claim.id, responseReference: null, state: "new" };
      }
      if (claim.status === "completed" && claim.responseReference != null) {
        return {
          claimId: claim.id,
          responseReference: validateResponseReference(claim.responseReference),
          state: "completed",
        };
      }
      return { claimId: claim.id, responseReference: null, state: "pending" };
    },
  );
}

/** Finalizes a claim made by claimIdempotentResearchWrite after provider work. */
export async function finalizeIdempotentResearchWrite(
  context: ResearchServiceContext,
  input: DerivedResearchIdempotency,
  claimId: string,
  responseReference: ResearchResponseReference,
  requiredPermissions: readonly string[],
): Promise<void> {
  if (context.actor.type !== "user") return forbidden();
  const metadata = derivedIdempotencyInputs.get(input as object);
  if (
    !metadata ||
    metadata.actorId !== context.actor.id ||
    metadata.workspaceId !== context.workspaceId ||
    !WORKER_UUID.test(claimId)
  ) {
    return invalidIdempotency();
  }
  const validatedReference = validateResponseReference(responseReference);
  await runResearchTransaction(
    context,
    { requiredPermissions },
    async (scopedContext) => {
      const [updated] = await scopedContext.database
        .update(idempotencyKeys)
        .set({
          responseReference: validatedReference,
          status: "completed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyKeys.workspaceId, scopedContext.workspaceId),
            eq(idempotencyKeys.actorId, scopedContext.actor.id),
            eq(idempotencyKeys.id, claimId),
            eq(idempotencyKeys.status, "pending"),
          ),
        )
        .returning({ id: idempotencyKeys.id });
      if (updated) return;
      const [existing] = await scopedContext.database
        .select({ status: idempotencyKeys.status })
        .from(idempotencyKeys)
        .where(
          and(
            eq(idempotencyKeys.workspaceId, scopedContext.workspaceId),
            eq(idempotencyKeys.actorId, scopedContext.actor.id),
            eq(idempotencyKeys.id, claimId),
          ),
        );
      if (existing?.status === "completed") return;
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation could not be completed.",
      );
    },
  );
}

/**
 * Runs an accepted research service write without opening a nested transaction
 * when the caller already owns the surrounding transaction.
 */
export async function withResearchWriteTransaction<T>(
  context: ResearchServiceContext,
  write: (database: Database) => Promise<T>,
): Promise<T> {
  if (retiredTransactionDatabases.has(context.database)) {
    return unavailableTransaction();
  }
  if (
    context.actor.type === "worker" &&
    !getTrustedWorkerAuditContext(context)
  ) {
    return forbidden();
  }
  if (callerOwnedDatabases.has(context.database)) {
    return write(context.database);
  }
  return context.database.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    callerOwnedDatabases.add(database);
    try {
      return await write(database);
    } finally {
      callerOwnedDatabases.delete(database);
      retiredTransactionDatabases.add(database);
    }
  });
}

const searchIndexMutationKeys = [
  "action",
  "sourceId",
  "sourceKind",
  "sourceVersion",
  "workspaceId",
] as const;
const searchIndexMutationKeySet = new Set<string>(searchIndexMutationKeys);
const searchIndexSourceKindSet = new Set<string>(SEARCH_INDEX_SOURCE_KINDS);

function invalidSearchIndexMaintenance(): never {
  throw createGraphQLError(
    "PRECONDITION_FAILED",
    "The search index maintenance request is invalid.",
  );
}

/** Dispatches closed mutation IDs on the exact active research transaction. */
export async function applySearchIndexMaintenance(
  context: ResearchServiceContext,
  database: Database,
  mutations: readonly SearchIndexMutation[],
): Promise<void> {
  if (
    !callerOwnedDatabases.has(database) ||
    retiredTransactionDatabases.has(database) ||
    (context.actor.type === "worker" &&
      (!getTrustedWorkerAuditContext(context) ||
        context.database !== database)) ||
    !Array.isArray(mutations) ||
    mutations.length === 0 ||
    mutations.length > 32 ||
    (context.searchIndexMaintenance.mode !== "disabled" &&
      context.searchIndexMaintenance.mode !== "transactional") ||
    typeof context.searchIndexMaintenance.apply !== "function"
  ) {
    return invalidSearchIndexMaintenance();
  }

  const seen = new Set<string>();
  for (const mutation of mutations) {
    if (
      mutation == null ||
      typeof mutation !== "object" ||
      Array.isArray(mutation) ||
      Object.getPrototypeOf(mutation) !== Object.prototype
    ) {
      return invalidSearchIndexMaintenance();
    }
    const ownKeys = Reflect.ownKeys(mutation);
    if (
      ownKeys.length !== searchIndexMutationKeys.length ||
      ownKeys.some(
        (key) => typeof key !== "string" || !searchIndexMutationKeySet.has(key),
      ) ||
      (mutation.action !== "upsert" && mutation.action !== "remove") ||
      !searchIndexSourceKindSet.has(mutation.sourceKind) ||
      !WORKER_UUID.test(mutation.sourceId) ||
      !WORKER_UUID.test(mutation.workspaceId) ||
      mutation.workspaceId !== context.workspaceId ||
      !Number.isSafeInteger(mutation.sourceVersion) ||
      mutation.sourceVersion < 1 ||
      mutation.sourceVersion > 2_147_483_647
    ) {
      return invalidSearchIndexMaintenance();
    }
    const identity = `${mutation.action}\0${mutation.sourceKind}\0${mutation.sourceId}\0${mutation.sourceVersion}`;
    if (seen.has(identity)) return invalidSearchIndexMaintenance();
    seen.add(identity);
  }

  await context.searchIndexMaintenance.apply(database, mutations);
}

export type DurableImportRowExecution<T> =
  | {
      readonly resultReferences: readonly string[];
      readonly status: "already_finished";
      readonly value: null;
    }
  | {
      readonly resultReferences: readonly string[];
      readonly status: "completed";
      readonly value: T;
    }
  | {
      readonly resultReferences: readonly [];
      readonly status: "rejected" | "dry_run_completed";
      readonly value: null;
    };

export type DurableImportRowSuccess<T> = {
  readonly resultReferences: readonly string[];
  readonly value: T;
};

export const DURABLE_IMPORT_ROW_REJECTION_CODES = [
  "INVALID_IMPORT_ROW",
  "PERSON_VALIDATION_FAILED",
  "FACT_VALIDATION_FAILED",
  "RELATIONSHIP_VALIDATION_FAILED",
  "PERSON_ENDPOINT_NOT_FOUND",
] as const;
export type DurableImportRowRejectionCode =
  (typeof DURABLE_IMPORT_ROW_REJECTION_CODES)[number];

declare const durableImportRowFinalizationBrand: unique symbol;
export type DurableImportRowFinalization = Readonly<{
  [durableImportRowFinalizationBrand]: true;
}>;
type InternalDurableImportRowFinalization =
  | Readonly<{
      diagnostic: { code: DurableImportRowRejectionCode; message: string };
      kind: "rejected";
    }>
  | Readonly<{ kind: "dry_run_completed" }>;

const rejectionMessages: Record<DurableImportRowRejectionCode, string> = {
  INVALID_IMPORT_ROW: "The import row is invalid.",
  PERSON_VALIDATION_FAILED: "The imported person is invalid.",
  FACT_VALIDATION_FAILED: "The imported fact is invalid.",
  RELATIONSHIP_VALIDATION_FAILED: "The imported relationship is invalid.",
  PERSON_ENDPOINT_NOT_FOUND:
    "An imported relationship endpoint is unavailable.",
};
const durableImportRowFinalizations = new WeakMap<
  object,
  InternalDurableImportRowFinalization
>();

function finalizationToken(
  finalization: InternalDurableImportRowFinalization,
): DurableImportRowFinalization {
  const token = Object.freeze({}) as DurableImportRowFinalization;
  durableImportRowFinalizations.set(token, Object.freeze(finalization));
  return token;
}

export function rejectDurableImportRow(input: {
  code: DurableImportRowRejectionCode;
}): DurableImportRowFinalization {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null) ||
    Reflect.ownKeys(input).length !== 1
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import rejection code is invalid.",
    );
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, "code");
  const code = descriptor && "value" in descriptor ? descriptor.value : null;
  if (
    !descriptor?.enumerable ||
    typeof code !== "string" ||
    !Object.hasOwn(rejectionMessages, code)
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import rejection code is invalid.",
    );
  }
  const typedCode = code as DurableImportRowRejectionCode;
  const message = rejectionMessages[typedCode];
  if (typeof message !== "string") {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import rejection code is invalid.",
    );
  }
  return finalizationToken({
    diagnostic: Object.freeze({ code: typedCode, message }),
    kind: "rejected",
  });
}

export function completeDurableImportRowDryRun(): DurableImportRowFinalization {
  return finalizationToken({ kind: "dry_run_completed" });
}

class DurableImportRowFinalizationSignal extends Error {
  constructor(readonly finalization: InternalDurableImportRowFinalization) {
    super("Durable import row finalization requested");
    this.name = "DurableImportRowFinalizationSignal";
  }
}

function importMode(mapping: unknown): "COMMIT" | "DRY_RUN" | null {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    return null;
  }
  const mode = (mapping as Record<string, unknown>).mode;
  return mode === "COMMIT" || mode === "DRY_RUN" ? mode : null;
}

function importRowOperation(input: {
  mapping: unknown;
  normalizedPayload: unknown;
}): ImportRowOperation | null {
  if (
    !input.mapping ||
    typeof input.mapping !== "object" ||
    Array.isArray(input.mapping) ||
    !input.normalizedPayload ||
    typeof input.normalizedPayload !== "object" ||
    Array.isArray(input.normalizedPayload)
  ) {
    return null;
  }
  const mapping = input.mapping as Record<string, unknown>;
  const definition = mapping.definition;
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    return null;
  }
  const mappingKind = (definition as Record<string, unknown>).recordKind;
  const rowKind = (input.normalizedPayload as Record<string, unknown>).kind;
  return (rowKind === "PERSON" || rowKind === "RELATIONSHIP") &&
    mappingKind === rowKind
    ? rowKind
    : null;
}

function resultReferences(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((item) => typeof item !== "string" || !WORKER_UUID.test(item))
  ) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import result references are invalid.",
    );
  }
  return Object.freeze([
    ...new Set(value.map((item) => (item as string).toLowerCase())),
  ]);
}

type DurableImportRowTransactionInput = {
  claimGeneration: number;
  encryptionKey: string;
  importRowId: string;
  jobId: string;
  leaseOwner: string;
  searchIndexMaintenance: SearchIndexMaintenance;
  workspaceId: string;
};

type DurableImportRowExecute<T> = (input: {
  context: ResearchServiceContext;
  mode: "COMMIT" | "DRY_RUN";
  row: Readonly<typeof importRows.$inferSelect>;
}) => Promise<DurableImportRowSuccess<T> | DurableImportRowFinalization>;

async function runDurableImportRowResearchTransactionPass<T>(
  database: Database,
  input: DurableImportRowTransactionInput,
  execute: DurableImportRowExecute<T>,
  finalization: InternalDurableImportRowFinalization | null,
): Promise<DurableImportRowExecution<T>> {
  return database.transaction(async (transaction) => {
    const scopedDatabase = transaction as unknown as Database;
    const lockedJobs = await scopedDatabase
      .select({
        attemptCount: jobs.attemptCount,
        createdBy: jobs.createdBy,
        encryptedPayload: jobs.encryptedPayload,
        id: jobs.id,
        kind: jobs.kind,
        leaseExpiresAt: jobs.leaseExpiresAt,
        leaseOwner: jobs.leaseOwner,
        payloadHash: jobs.payloadHash,
      })
      .from(jobs)
      .where(
        and(
          eq(jobs.id, input.jobId),
          eq(jobs.workspaceId, input.workspaceId),
          eq(jobs.kind, "import_execute"),
          eq(jobs.state, "running"),
          eq(jobs.leaseOwner, input.leaseOwner),
          eq(jobs.claimGeneration, input.claimGeneration),
          gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
        ),
      )
      .limit(2)
      .for("update");
    const lockedJob = lockedJobs[0];
    if (lockedJobs.length !== 1 || !lockedJob) {
      if (finalization) return retryableLeaseLoss();
      return forbidden();
    }
    if (
      typeof lockedJob.createdBy !== "string" ||
      !(lockedJob.leaseExpiresAt instanceof Date) ||
      lockedJob.kind !== "import_execute"
    ) {
      return forbidden();
    }
    let importId: string;
    try {
      const payload = decodeJobPayload({
        encryptedPayload: lockedJob.encryptedPayload,
        key: input.encryptionKey,
        kind: "import_execute",
        payloadHash: lockedJob.payloadHash,
      });
      if (payload.kind !== "import_execute") return forbidden();
      importId = payload.importId;
    } catch {
      return forbidden();
    }
    const rows = await scopedDatabase
      .select({
        importMapping: imports.mapping,
        importRow: importRows,
        memberId: members.id,
        principalId: workspacePrincipals.id,
        role: members.role,
        userId: members.userId,
      })
      .from(imports)
      .innerJoin(
        importRows,
        and(
          eq(importRows.workspaceId, imports.workspaceId),
          eq(importRows.importId, imports.id),
          eq(importRows.id, input.importRowId),
        ),
      )
      .innerJoin(
        members,
        and(
          eq(members.workspaceId, imports.workspaceId),
          eq(members.userId, lockedJob.createdBy),
        ),
      )
      .innerJoin(
        workspaces,
        and(
          eq(workspaces.id, members.workspaceId),
          eq(workspaces.organizationId, members.organizationId),
        ),
      )
      .innerJoin(
        workspacePrincipals,
        and(
          eq(workspacePrincipals.workspaceId, imports.workspaceId),
          eq(workspacePrincipals.principalType, "user"),
          eq(workspacePrincipals.userId, lockedJob.createdBy),
        ),
      )
      .where(
        and(
          eq(imports.id, importId),
          eq(imports.workspaceId, input.workspaceId),
          eq(imports.executionJobId, input.jobId),
          eq(imports.state, "running"),
          eq(workspaces.state, "active"),
          isNull(workspaces.deletedAt),
        ),
      )
      .limit(2)
      .for("update");
    const live = rows[0];
    if (
      rows.length !== 1 ||
      !live ||
      !isWorkspaceRole(live.role) ||
      typeof live.userId !== "string"
    ) {
      return forbidden();
    }
    const operation = importRowOperation({
      mapping: live.importMapping,
      normalizedPayload: live.importRow.normalizedPayload,
    });
    if (!operation) return forbidden();
    const mode = importMode(live.importMapping);
    if (!mode) return forbidden();
    const requiredPermissions = importRowPermissionBundles[operation];
    const livePermissions = rolePermissionKeys(live.role);
    if (
      requiredPermissions.some((permission) => !livePermissions.has(permission))
    ) {
      return forbidden();
    }
    const existingReferences = resultReferences(
      live.importRow.resultReferences,
    );
    if (
      live.importRow.state === "succeeded" ||
      live.importRow.state === "rejected"
    ) {
      return {
        resultReferences: existingReferences,
        status: "already_finished",
        value: null,
      };
    }
    if (live.importRow.state !== "processing") return forbidden();

    if (finalization) {
      if (finalization.kind === "dry_run_completed" && mode !== "DRY_RUN") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The import row finalization does not match its execution mode.",
        );
      }
      const [stillLeased] = await scopedDatabase
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.kind, "import_execute"),
            eq(jobs.state, "running"),
            eq(jobs.leaseOwner, input.leaseOwner),
            eq(jobs.claimGeneration, input.claimGeneration),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!stillLeased) return retryableLeaseLoss();
      const rejected = finalization.kind === "rejected";
      const [finished] = await scopedDatabase
        .update(importRows)
        .set({
          state: rejected ? "rejected" : "succeeded",
          resultReferences: [],
          validationErrors: rejected ? [finalization.diagnostic] : [],
          updatedAt: new Date(),
          updatedBy: live.userId,
        })
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, importId),
            eq(importRows.id, input.importRowId),
            eq(importRows.state, "processing"),
          ),
        )
        .returning({ id: importRows.id });
      if (!finished) return forbidden();
      return {
        resultReferences: [],
        status: rejected ? "rejected" : "dry_run_completed",
        value: null,
      };
    }

    const permissions = new ImmutablePermissionSet(requiredPermissions);
    const leaseExpiresAt = lockedJob.leaseExpiresAt.toISOString();
    const actor = Object.freeze({
      type: "worker" as const,
      id: live.userId,
      memberId: live.memberId,
      principalId: live.principalId,
      role: live.role,
      importId,
      importRowId: input.importRowId,
      jobId: input.jobId,
      leaseExpiresAt,
      leaseOwner: input.leaseOwner,
      fencingToken: input.claimGeneration,
      operation,
    });
    const requestId = `worker:${input.jobId}`;
    const context: ResearchServiceContext = Object.freeze({
      actor,
      database: scopedDatabase,
      permissions,
      requestId,
      searchIndexMaintenance: input.searchIndexMaintenance,
      workspaceId: input.workspaceId,
    });
    const trusted = Object.freeze({
      database: scopedDatabase,
      fencingToken: input.claimGeneration,
      importId,
      importRowId: input.importRowId,
      jobId: input.jobId,
      leaseExpiresAt,
      leaseOwner: input.leaseOwner,
      memberId: live.memberId,
      operation,
      permissions,
      principalId: live.principalId,
      requestId,
      role: live.role,
      searchIndexMaintenance: input.searchIndexMaintenance,
      userId: live.userId,
      workspaceId: input.workspaceId,
    });
    callerOwnedDatabases.add(scopedDatabase);
    trustedWorkerAuditContexts.set(context, trusted);
    try {
      const result = await execute({
        context,
        mode,
        row: Object.freeze({ ...live.importRow }),
      });
      const requestedFinalization =
        result !== null && typeof result === "object"
          ? durableImportRowFinalizations.get(result)
          : undefined;
      if (requestedFinalization) {
        durableImportRowFinalizations.delete(result);
        if (
          requestedFinalization.kind === "dry_run_completed" &&
          mode !== "DRY_RUN"
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The import row finalization does not match its execution mode.",
          );
        }
        throw new DurableImportRowFinalizationSignal(requestedFinalization);
      }
      if (mode === "DRY_RUN") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "A dry-run import row must request rollback finalization.",
        );
      }
      const success = result as DurableImportRowSuccess<T>;
      const references = resultReferences(success?.resultReferences);
      const [stillLeased] = await scopedDatabase
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, input.jobId),
            eq(jobs.workspaceId, input.workspaceId),
            eq(jobs.kind, "import_execute"),
            eq(jobs.state, "running"),
            eq(jobs.leaseOwner, input.leaseOwner),
            eq(jobs.claimGeneration, input.claimGeneration),
            gt(jobs.leaseExpiresAt, sql`clock_timestamp()`),
          ),
        )
        .limit(1);
      if (!stillLeased) return forbidden();
      const [finished] = await scopedDatabase
        .update(importRows)
        .set({
          state: "succeeded",
          resultReferences: [...references],
          validationErrors: [],
          updatedAt: new Date(),
          updatedBy: live.userId,
        })
        .where(
          and(
            eq(importRows.workspaceId, input.workspaceId),
            eq(importRows.importId, importId),
            eq(importRows.id, input.importRowId),
            eq(importRows.state, "processing"),
          ),
        )
        .returning({ id: importRows.id });
      if (!finished) return forbidden();
      return {
        resultReferences: references,
        status: "completed",
        value: success.value,
      };
    } finally {
      trustedWorkerAuditContexts.delete(context);
      callerOwnedDatabases.delete(scopedDatabase);
      retiredTransactionDatabases.add(scopedDatabase);
    }
  });
}

/**
 * Runs one already-claimed import row under its exact live PostgreSQL lease.
 * COMMIT success binds domain, audit, and row writes in one transaction.
 * Expected rejection and DRY_RUN completion roll domain work back, then use a
 * second fully revalidated and fenced transaction to persist only row outcome.
 */
export async function runDurableImportRowResearchTransaction<T>(
  database: Database,
  input: DurableImportRowTransactionInput,
  execute: DurableImportRowExecute<T>,
): Promise<DurableImportRowExecution<T>> {
  if (
    !WORKER_UUID.test(input.workspaceId) ||
    !WORKER_UUID.test(input.importRowId) ||
    !WORKER_UUID.test(input.jobId) ||
    !WORKER_UUID.test(input.leaseOwner) ||
    !WORKER_ENCRYPTION_KEY.test(input.encryptionKey) ||
    !Number.isSafeInteger(input.claimGeneration) ||
    input.claimGeneration < 1 ||
    retiredTransactionDatabases.has(database) ||
    callerOwnedDatabases.has(database)
  ) {
    return forbidden();
  }
  try {
    return await runDurableImportRowResearchTransactionPass(
      database,
      input,
      execute,
      null,
    );
  } catch (error) {
    if (!(error instanceof DurableImportRowFinalizationSignal)) throw error;
    return runDurableImportRowResearchTransactionPass(
      database,
      input,
      execute,
      error.finalization,
    );
  }
}

/**
 * Supplies one live user- or API-key-owned transaction to accepted research
 * services. Static permission checks precede database access; live identity,
 * workspace lifecycle, and authority are revalidated before any domain lookup
 * or write.
 */
export async function runResearchTransaction<T>(
  context: ResearchServiceContext,
  input: {
    requiredPermissions: readonly string[];
    workspaceSerialization?: "placeHierarchy";
  },
  write: (context: ResearchServiceContext) => Promise<T>,
): Promise<T> {
  const requiredPermissions = requireResearchPermissions(
    context,
    input.requiredPermissions,
  );
  if (
    retiredTransactionDatabases.has(context.database) ||
    callerOwnedDatabases.has(context.database)
  ) {
    return unavailableTransaction();
  }
  return context.database.transaction(async (transaction) => {
    const database = transaction as unknown as Database;
    callerOwnedDatabases.add(database);
    try {
      const scopedContext: ResearchServiceContext = { ...context, database };
      // Place hierarchy writes and the database trigger share this exact lock
      // namespace. Taking the conservative global hierarchy lock before
      // identity revalidation establishes the canonical order: hierarchy
      // lock, then live authority locks, then place rows. The matching BEFORE
      // STATEMENT trigger also runs before direct SQL can lock a place row.
      // Place writes are infrequent enough that safety is preferable to a
      // per-workspace lock that a row trigger cannot acquire early enough.
      if (input.workspaceSerialization === "placeHierarchy") {
        const lockIdentity = "humans:place-hierarchy:global";
        await database.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`,
        );
      }
      if (context.actor.type === "user") {
        await requireLiveResearchIdentity(
          database,
          scopedContext as ResearchServiceContext & {
            actor: { type: "user" };
          },
          requiredPermissions,
        );
      } else if (context.actor.type === "apiKey") {
        await requireLiveApiKeyIdentity(
          database,
          scopedContext as ResearchServiceContext & {
            actor: { type: "apiKey" };
          },
          requiredPermissions,
        );
      } else {
        return forbidden();
      }
      return await write(scopedContext);
    } finally {
      callerOwnedDatabases.delete(database);
      retiredTransactionDatabases.add(database);
    }
  });
}

/**
 * Executes or replays one outermost session-user write. The opaque metadata can
 * only be produced by deriveResearchIdempotency; raw keys and request bodies are
 * never accepted or persisted here.
 */
export async function runIdempotentResearchWrite<
  T extends ResearchResponseReference,
>(
  context: ResearchServiceContext,
  input: DerivedResearchIdempotency,
  requiredPermissions: readonly string[],
  write: (context: ResearchServiceContext) => Promise<T>,
): Promise<{ replayed: boolean; responseReference: T }> {
  if (context.actor.type !== "user") return forbidden();
  if (
    retiredTransactionDatabases.has(context.database) ||
    callerOwnedDatabases.has(context.database)
  ) {
    return unavailableTransaction();
  }
  if (
    input == null ||
    typeof input !== "object" ||
    !derivedIdempotencyInputs.has(input)
  ) {
    return invalidIdempotency();
  }
  const metadata = derivedIdempotencyInputs.get(input);
  const now = new Date();
  if (
    !metadata ||
    metadata.actorId !== context.actor.id ||
    metadata.workspaceId !== context.workspaceId ||
    metadata.expiresAtMs <= now.getTime()
  ) {
    return invalidIdempotency();
  }

  return runResearchTransaction(
    context,
    { requiredPermissions },
    async (scopedContext) => {
      const identity = and(
        eq(idempotencyKeys.workspaceId, scopedContext.workspaceId),
        eq(idempotencyKeys.actorId, scopedContext.actor.id),
        eq(idempotencyKeys.operation, metadata.operation),
        eq(idempotencyKeys.keyHash, metadata.keyHash),
      );
      await scopedContext.database
        .delete(idempotencyKeys)
        .where(and(identity, lte(idempotencyKeys.expiresAt, now)));
      const [inserted] = await scopedContext.database
        .insert(idempotencyKeys)
        .values({
          id: newId(),
          workspaceId: scopedContext.workspaceId,
          actorId: scopedContext.actor.id,
          operation: metadata.operation,
          keyHash: metadata.keyHash,
          requestHash: metadata.requestHash,
          status: "pending",
          expiresAt: new Date(metadata.expiresAtMs),
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({
          target: [
            idempotencyKeys.workspaceId,
            idempotencyKeys.actorId,
            idempotencyKeys.operation,
            idempotencyKeys.keyHash,
          ],
        })
        .returning({ id: idempotencyKeys.id });
      const [claim] = await scopedContext.database
        .select()
        .from(idempotencyKeys)
        .where(identity)
        .for("update");
      if (!claim) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation could not be claimed.",
        );
      }
      if (claim.requestHash !== metadata.requestHash) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotency key is already bound to another request.",
        );
      }
      if (!inserted) {
        if (claim.status !== "completed" || claim.responseReference == null) {
          throw createGraphQLError(
            "CONFLICT",
            "The idempotent operation is not replayable.",
          );
        }
        return {
          replayed: true,
          responseReference: validateResponseReference(
            claim.responseReference,
          ) as T,
        };
      }

      const responseReference = validateResponseReference(
        await write(scopedContext),
      ) as T;
      const [completed] = await scopedContext.database
        .update(idempotencyKeys)
        .set({
          responseReference,
          status: "completed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(idempotencyKeys.workspaceId, scopedContext.workspaceId),
            eq(idempotencyKeys.id, claim.id),
            eq(idempotencyKeys.status, "pending"),
          ),
        )
        .returning({ id: idempotencyKeys.id });
      if (!completed) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation could not be completed.",
        );
      }
      return { replayed: false, responseReference };
    },
  );
}

/**
 * Executes or replays one principal-bound mutation. An advisory transaction
 * lock serializes first claim and expiry takeover, while runResearchTransaction
 * revalidates the live user session or API key before any claim/domain write.
 */
export async function runPrincipalIdempotentResearchWrite<
  T extends ResearchResponseReference,
>(
  context: ResearchServiceContext,
  input: DerivedPrincipalIdempotency,
  requiredPermissions: readonly string[],
  write: (context: ResearchServiceContext) => Promise<T>,
): Promise<{ replayed: boolean; responseReference: T }> {
  if (context.actor.type !== "user" && context.actor.type !== "apiKey") {
    return forbidden();
  }
  if (
    retiredTransactionDatabases.has(context.database) ||
    callerOwnedDatabases.has(context.database) ||
    input == null ||
    typeof input !== "object" ||
    !derivedPrincipalIdempotencyInputs.has(input)
  ) {
    return invalidIdempotency();
  }
  const metadata = derivedPrincipalIdempotencyInputs.get(input);
  if (
    !metadata ||
    metadata.actorPrincipalId !== context.actor.principalId ||
    metadata.workspaceId !== context.workspaceId ||
    metadata.expiresAtMs <= Date.now()
  ) {
    return invalidIdempotency();
  }
  return runResearchTransaction(
    context,
    {
      requiredPermissions,
      ...(metadata.operation.startsWith("location.place.")
        ? { workspaceSerialization: "placeHierarchy" as const }
        : {}),
    },
    async (scopedContext) => {
      const database = scopedContext.database;
      const lockIdentity = `${metadata.workspaceId}:${metadata.actorPrincipalId}:${metadata.operation}:${metadata.keyHash}`;
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`,
      );
      const identity = and(
        eq(locationMutationIdempotency.workspaceId, metadata.workspaceId),
        eq(
          locationMutationIdempotency.actorPrincipalId,
          metadata.actorPrincipalId,
        ),
        eq(locationMutationIdempotency.operation, metadata.operation),
        eq(locationMutationIdempotency.keyHash, metadata.keyHash),
      );
      const [prior] = await database
        .select()
        .from(locationMutationIdempotency)
        .where(identity)
        .for("update");
      const now = new Date();
      let claim: typeof locationMutationIdempotency.$inferSelect | null =
        prior ?? null;
      if (claim && claim.expiresAt <= now) {
        await database
          .delete(locationMutationIdempotency)
          .where(
            and(
              eq(locationMutationIdempotency.workspaceId, metadata.workspaceId),
              eq(locationMutationIdempotency.id, claim.id),
              lte(locationMutationIdempotency.expiresAt, now),
            ),
          );
        claim = null;
      }
      if (claim) {
        if (claim.requestHash !== metadata.requestHash) {
          throw createGraphQLError(
            "CONFLICT",
            "The idempotency key is already bound to another request.",
          );
        }
        if (claim.status !== "completed" || claim.responseReference == null) {
          throw createGraphQLError(
            "CONFLICT",
            "The idempotent operation is not replayable.",
          );
        }
        return {
          replayed: true,
          responseReference: validateResponseReference(
            claim.responseReference,
          ) as T,
        };
      }
      const [inserted] = await database
        .insert(locationMutationIdempotency)
        .values({
          id: newId(),
          workspaceId: metadata.workspaceId,
          actorPrincipalId: metadata.actorPrincipalId,
          operation: metadata.operation,
          keyHash: metadata.keyHash,
          requestHash: metadata.requestHash,
          status: "pending",
          expiresAt: new Date(metadata.expiresAtMs),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: locationMutationIdempotency.id });
      if (!inserted) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation could not be claimed.",
        );
      }
      const responseReference = validateResponseReference(
        await write(scopedContext),
      ) as T;
      const [completed] = await database
        .update(locationMutationIdempotency)
        .set({
          responseReference,
          status: "completed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(locationMutationIdempotency.workspaceId, metadata.workspaceId),
            eq(locationMutationIdempotency.id, inserted.id),
            eq(locationMutationIdempotency.status, "pending"),
          ),
        )
        .returning({ id: locationMutationIdempotency.id });
      if (!completed) {
        throw createGraphQLError(
          "CONFLICT",
          "The idempotent operation could not be completed.",
        );
      }
      return { replayed: false, responseReference };
    },
  );
}
