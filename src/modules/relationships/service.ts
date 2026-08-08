import { newId } from "@/db/id";
import { people as peopleTable } from "@/db/schema/people";
import { relationships } from "@/db/schema/relationships";
import { and, eq } from "drizzle-orm";
import { createGraphQLError } from "@/graphql/errors";
import { decodeResearchCursor, normalizePagination } from "@/graphql/limits";
import {
  canAccessResource,
  createAuditService,
  resourceVisibilitySql,
  visibleResourceIds,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction as writeTransaction,
  type CanonicalRequestMaterial,
} from "@/modules/audit/transactions";
import { createPeopleRepository } from "@/modules/people/repository";
import type { Connection, MutationOutcome } from "@/modules/people/service";
import {
  canonicalizeRelationshipEndpoints,
  normalizeHumanText,
  normalizeNamespaceKey,
  validateBoundedJson,
  validateJsonSchema,
  validateTemporal,
  validateUnitDecimal,
  type ValidationIssue,
} from "@/modules/facts/validation";

import {
  createRelationshipsRepository,
  type RelationshipRow,
  type RelationshipTypeRow,
} from "./repository";

function invalid<T>(issues: ValidationIssue[]): MutationOutcome<T> {
  return { resource: null, issues, code: "VALIDATION_FAILED" };
}
function conflict<T>(version?: number): MutationOutcome<T> {
  return {
    resource: null,
    issues: [],
    code: "CONFLICT",
    currentVersion: version,
  };
}
function encode(value: Record<string, unknown>) {
  return Buffer.from(JSON.stringify({ v: 1, ...value }), "utf8").toString(
    "base64url",
  );
}
const decode = decodeResearchCursor;
const RELATIONSHIP_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const RELATIONSHIP_TYPE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const RELATIONSHIP_REFERENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function fieldMaterial(
  value: CanonicalRequestMaterial | undefined,
): CanonicalRequestMaterial {
  return value === undefined
    ? { present: false }
    : { present: true, value: value ?? null };
}

const relationshipStates = [
  "asserted",
  "inferred",
  "corroborated",
  "disputed",
  "disproven",
  "inactive",
] as const;

function validateRelationshipState(
  value: string | null | undefined,
  current?: string,
): { value: string | null; issues: ValidationIssue[] } {
  const state = value?.trim().toLowerCase() || null;
  if (
    !state ||
    !relationshipStates.includes(state as (typeof relationshipStates)[number])
  )
    return {
      value: null,
      issues: [
        {
          path: ["state"],
          code: "INVALID_ENUM",
          message: "Invalid relationship state.",
        },
      ],
    };
  const transitions: Record<string, readonly string[]> = {
    asserted: ["asserted", "corroborated", "disputed", "disproven", "inactive"],
    inferred: [
      "inferred",
      "asserted",
      "corroborated",
      "disputed",
      "disproven",
      "inactive",
    ],
    corroborated: ["corroborated", "disputed", "disproven", "inactive"],
    disputed: ["disputed", "corroborated", "disproven", "inactive"],
    disproven: ["disproven", "inactive"],
    inactive: ["inactive"],
  };
  if (current && !(transitions[current] ?? []).includes(state))
    return {
      value: null,
      issues: [
        {
          path: ["state"],
          code: "INVALID_TRANSITION",
          message: "Invalid relationship state transition.",
        },
      ],
    };
  return { value: state, issues: [] };
}

export function createRelationshipsService(context: ResearchServiceContext) {
  const repository = createRelationshipsRepository(context.database);
  const people = createPeopleRepository(context.database);
  const audit = createAuditService(context);
  const relationshipVisibility = resourceVisibilitySql(context, {
    resourceKind: "relationship",
    id: relationships.id,
    sensitivity: relationships.sensitivity,
  });
  const personVisibility = resourceVisibilitySql(context, {
    resourceKind: "person",
    id: peopleTable.id,
    sensitivity: peopleTable.sensitivity,
  });
  async function visibleIds(
    rows: readonly RelationshipRow[],
  ): Promise<ReadonlySet<string>> {
    return visibleResourceIds(context.database, context, {
      resourceKind: "relationship",
      resources: rows.map((row) => ({
        id: row.id,
        sensitivity: row.sensitivity,
      })),
    });
  }
  async function visible(row: RelationshipRow) {
    return (await visibleIds([row])).has(row.id);
  }
  async function replayRelationship(
    responseReference: Readonly<
      Record<string, string | number | boolean | null>
    >,
  ): Promise<RelationshipRow> {
    const relationshipId = responseReference.relationshipId;
    const version = responseReference.version;
    if (
      typeof relationshipId !== "string" ||
      !RELATIONSHIP_REFERENCE_UUID.test(relationshipId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const [row] = await context.database
      .select()
      .from(relationships)
      .where(
        and(
          eq(relationships.workspaceId, context.workspaceId),
          eq(relationships.id, relationshipId),
        ),
      )
      .limit(1);
    if (!row || !(await visible(row)))
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    if (row.version !== version)
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    return row;
  }
  async function replayRelationshipType(
    responseReference: Readonly<
      Record<string, string | number | boolean | null>
    >,
  ): Promise<RelationshipTypeRow> {
    const relationshipTypeId = responseReference.relationshipTypeId;
    const version = responseReference.version;
    if (
      typeof relationshipTypeId !== "string" ||
      !RELATIONSHIP_REFERENCE_UUID.test(relationshipTypeId) ||
      typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 1
    ) {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The operation response reference is invalid.",
      );
    }
    const row = await repository.getType({
      workspaceId: context.workspaceId,
      id: relationshipTypeId,
    });
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    if (row.version !== version)
      throw createGraphQLError(
        "CONFLICT",
        "The idempotent operation response is no longer current.",
      );
    return row;
  }
  async function requirePerson(id: string) {
    const row = await people.getById({ workspaceId: context.workspaceId, id });
    if (
      !row ||
      !(await canAccessResource(context.database, context, {
        id,
        resourceKind: "person",
        sensitivity: row.sensitivity,
      }))
    )
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
  }
  return {
    async getType(id: string) {
      return repository.getType({ workspaceId: context.workspaceId, id });
    },
    async getTypesByIds(ids: readonly string[]) {
      const rows = await repository.getTypesByIds({
        workspaceId: context.workspaceId,
        ids,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listTypes(input: {
      first?: number | null;
      after?: string | null;
      namespace?: string | null;
      key?: string | null;
      state?: string | null;
      directed?: boolean | null;
      allowsSelf?: boolean | null;
      allowedMultiplicity?: string | null;
    }): Promise<Connection<RelationshipTypeRow>> {
      const page = normalizePagination(input);
      const namespace = input.namespace
        ? normalizeNamespaceKey(input.namespace, ["filter", "namespace"])
        : { value: null, issues: [] as ValidationIssue[] };
      const key = input.key
        ? normalizeNamespaceKey(input.key, ["filter", "key"])
        : { value: null, issues: [] as ValidationIssue[] };
      if (namespace.issues.length || key.issues.length)
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The relationship type filter is invalid.",
        );
      const decoded = decode(page.after, "relationship-type-key-asc");
      const cursor =
        decoded &&
        typeof decoded.n === "string" &&
        typeof decoded.k === "string"
          ? { namespace: decoded.n, key: decoded.k, id: decoded.i as string }
          : null;
      if (decoded && !cursor)
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const rows = await repository.listTypes({
        workspaceId: context.workspaceId,
        limit: page.first + 1,
        cursor,
        namespace: namespace.value,
        key: key.value,
        state: input.state as RelationshipTypeRow["state"] | null | undefined,
        directed: input.directed,
        allowsSelf: input.allowsSelf,
        allowedMultiplicity: input.allowedMultiplicity,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({
                o: "relationship-type-key-asc",
                n: last.namespace,
                k: last.key,
                i: last.id,
              })
            : null,
        },
      };
    },
    async createType(input: {
      idempotencyKey?: string | null;
      namespace?: string | null;
      key: string;
      forwardLabel: string;
      inverseLabel: string;
      directed?: boolean | null;
      allowsSelf?: boolean | null;
      allowedMultiplicity?: string | null;
      metadataSchema?: unknown;
      state?: string | null;
    }): Promise<MutationOutcome<RelationshipTypeRow>> {
      const namespace = normalizeNamespaceKey(input.namespace ?? "workspace", [
        "namespace",
      ]);
      const key = normalizeNamespaceKey(input.key, ["key"]);
      const forward = normalizeHumanText(input.forwardLabel, {
        path: ["forwardLabel"],
        min: 1,
        max: 200,
      });
      const inverse = normalizeHumanText(input.inverseLabel, {
        path: ["inverseLabel"],
        min: 1,
        max: 200,
      });
      const metadata = validateBoundedJson(input.metadataSchema ?? {}, {
        objectOnly: true,
        path: ["metadataSchema"],
      });
      const issues = [
        ...namespace.issues,
        ...key.issues,
        ...forward.issues,
        ...inverse.issues,
        ...metadata.issues,
      ];
      const multiplicity = (
        input.allowedMultiplicity ?? "many_to_many"
      ).toLowerCase();
      const state = (input.state ?? "active").toLowerCase();
      if (
        !["one_to_one", "one_to_many", "many_to_one", "many_to_many"].includes(
          multiplicity,
        )
      )
        issues.push({
          path: ["allowedMultiplicity"],
          code: "INVALID_ENUM",
          message: "Invalid multiplicity.",
        });
      if (!["active", "inactive", "archived"].includes(state))
        issues.push({
          path: ["state"],
          code: "INVALID_ENUM",
          message: "Invalid lifecycle state.",
        });
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent relationship-type creation is not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(
            Date.now() + RELATIONSHIP_TYPE_IDEMPOTENCY_TTL_MS,
          ),
          idempotencyKey: input.idempotencyKey,
          operation: "relationship_type.create.graphql",
          requestMaterial: {
            allowsSelf: input.allowsSelf ?? false,
            allowedMultiplicity: multiplicity,
            directed: input.directed ?? true,
            forwardLabel: forward.value!,
            inverseLabel: inverse.value!,
            key: key.value!,
            metadataSchema: metadata.value as CanonicalRequestMaterial,
            namespace: namespace.value!,
            state,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["relationship:create"],
          async (scopedContext) => {
            const outcome = await createRelationshipsService(
              scopedContext,
            ).createType({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The relationship type could not be created.",
              );
            }
            return {
              relationshipTypeId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayRelationshipType(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      try {
        const row = await writeTransaction(context, async (transaction) => {
          const scoped = createRelationshipsRepository(
            transaction as unknown as typeof context.database,
          );
          const created = await scoped.createType({
            workspaceId: context.workspaceId,
            value: {
              id: newId(),
              namespace: namespace.value!,
              key: key.value!,
              forwardLabel: forward.value!,
              inverseLabel: inverse.value!,
              directed: input.directed ?? true,
              allowsSelf: input.allowsSelf ?? false,
              allowedMultiplicity: multiplicity,
              metadataSchema: metadata.value,
              state: state as RelationshipTypeRow["state"],
              createdBy: context.actor.principalId,
              updatedBy: context.actor.principalId,
            },
          });
          await audit.write(transaction as unknown as typeof context.database, {
            action: "relationshipType.create",
            resourceKind: "relationshipType",
            resourceId: created.id,
            changedFields: [
              "namespace",
              "key",
              "directed",
              "allowsSelf",
              "allowedMultiplicity",
              "state",
            ],
            metadata: { state: created.state, version: created.version },
          });
          await applySearchIndexMaintenance(context, transaction, [
            {
              action: "upsert",
              sourceId: created.id,
              sourceKind: "relationship_type",
              sourceVersion: created.version,
              workspaceId: context.workspaceId,
            },
          ]);
          return created;
        });
        return { resource: row, issues: [], code: null };
      } catch (error) {
        if ((error as { code?: string }).code === "23505") return conflict();
        throw error;
      }
    },
    async updateType(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      forwardLabel?: string | null;
      inverseLabel?: string | null;
      allowsSelf?: boolean | null;
      allowedMultiplicity?: string | null;
      metadataSchema?: unknown;
      state?: string | null;
    }): Promise<MutationOutcome<RelationshipTypeRow>> {
      const current = await repository.getType({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (!current)
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      const issues: ValidationIssue[] = [];
      const patch: Record<string, unknown> = {
        updatedAt: new Date(),
        updatedBy: context.actor.principalId,
      };
      const changed: string[] = [];
      for (const [key, value] of [
        ["forwardLabel", input.forwardLabel],
        ["inverseLabel", input.inverseLabel],
      ] as const) {
        if (value !== undefined) {
          const normalized = normalizeHumanText(value, {
            path: [key],
            min: 1,
            max: 200,
          });
          if (normalized.issues.length) issues.push(...normalized.issues);
          else patch[key] = normalized.value;
          changed.push(key);
        }
      }
      if (input.allowsSelf !== undefined && input.allowsSelf !== null) {
        patch.allowsSelf = input.allowsSelf;
        changed.push("allowsSelf");
      }
      if (input.allowedMultiplicity !== undefined) {
        const value = input.allowedMultiplicity?.toLowerCase();
        if (
          !value ||
          ![
            "one_to_one",
            "one_to_many",
            "many_to_one",
            "many_to_many",
          ].includes(value)
        )
          issues.push({
            path: ["allowedMultiplicity"],
            code: "INVALID_ENUM",
            message: "Invalid multiplicity.",
          });
        else patch.allowedMultiplicity = value;
        changed.push("allowedMultiplicity");
      }
      if (input.metadataSchema !== undefined) {
        const metadata = validateBoundedJson(input.metadataSchema, {
          objectOnly: true,
          path: ["metadataSchema"],
        });
        if (metadata.issues.length) issues.push(...metadata.issues);
        else patch.metadataSchema = metadata.value;
        changed.push("metadataSchema");
      }
      if (input.state !== undefined) {
        const value = input.state?.toLowerCase();
        if (!value || !["active", "inactive", "archived"].includes(value))
          issues.push({
            path: ["state"],
            code: "INVALID_ENUM",
            message: "Invalid lifecycle state.",
          });
        else patch.state = value;
        changed.push("state");
      }
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent relationship-type updates are not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(
            Date.now() + RELATIONSHIP_TYPE_IDEMPOTENCY_TTL_MS,
          ),
          idempotencyKey: input.idempotencyKey,
          operation: "relationship_type.update.graphql",
          requestMaterial: {
            allowsSelf: fieldMaterial(input.allowsSelf),
            allowedMultiplicity: fieldMaterial(
              input.allowedMultiplicity === undefined
                ? undefined
                : (input.allowedMultiplicity?.toLowerCase() ?? null),
            ),
            expectedVersion: input.expectedVersion,
            forwardLabel: fieldMaterial(
              input.forwardLabel === undefined
                ? undefined
                : (input.forwardLabel?.normalize("NFKC").trim() ?? null),
            ),
            id: input.id,
            inverseLabel: fieldMaterial(
              input.inverseLabel === undefined
                ? undefined
                : (input.inverseLabel?.normalize("NFKC").trim() ?? null),
            ),
            metadataSchema: fieldMaterial(
              input.metadataSchema as CanonicalRequestMaterial | undefined,
            ),
            state: fieldMaterial(
              input.state === undefined
                ? undefined
                : (input.state?.toLowerCase() ?? null),
            ),
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["relationship:update"],
          async (scopedContext) => {
            const outcome = await createRelationshipsService(
              scopedContext,
            ).updateType({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The relationship type could not be updated.",
              );
            }
            return {
              relationshipTypeId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayRelationshipType(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createRelationshipsRepository(
          transaction as unknown as typeof context.database,
        );
        const updated = await scoped.updateTypeIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "relationshipType.update",
          resourceKind: "relationshipType",
          resourceId: updated.id,
          changedFields: changed,
          metadata: { state: updated.state, version: updated.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "relationship_type",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return updated;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
    async get(id: string) {
      const row = await repository.get({
        workspaceId: context.workspaceId,
        id,
        visibility: relationshipVisibility,
      });
      return row;
    },
    async getByIds(ids: readonly string[]) {
      const rows = await repository.getByIds({
        workspaceId: context.workspaceId,
        ids,
        visibility: relationshipVisibility,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },
    async listForPeople(
      keys: readonly {
        personId: string;
        first: number;
        after: string | null;
      }[],
    ): Promise<Connection<RelationshipRow>[]> {
      const pages = keys.map((key, pageKey) => {
        normalizePagination(key);
        const decoded = decode(key.after, "relationship-created-desc");
        const cursor =
          decoded && typeof decoded.t === "string"
            ? { createdAt: new Date(decoded.t), id: decoded.i as string }
            : null;
        if (cursor && Number.isNaN(cursor.createdAt.getTime()))
          throw createGraphQLError(
            "VALIDATION_FAILED",
            "The cursor is invalid.",
          );
        return { pageKey, personId: key.personId, cursor };
      });
      const chunkSize = Math.min(
        101,
        Math.max(...keys.map((key) => key.first)) + 1,
      );
      const rows = await repository.listForPeople({
        workspaceId: context.workspaceId,
        pages,
        limitPerPerson: chunkSize,
        visibility: relationshipVisibility,
        personVisibility,
      });
      const grouped = new Map<number, RelationshipRow[]>();
      for (const row of rows)
        grouped.set(row.pageKey, [...(grouped.get(row.pageKey) ?? []), row]);
      return keys.map((key, pageKey) => {
        const values = grouped.get(pageKey) ?? [];
        const nodes = values.slice(0, key.first);
        const last = nodes.at(-1);
        return {
          nodes,
          pageInfo: {
            hasNextPage: values.length > key.first,
            endCursor: last
              ? encode({
                  o: "relationship-created-desc",
                  t: last.createdAt.toISOString(),
                  i: last.id,
                })
              : null,
          },
        };
      });
    },
    async list(input: {
      first?: number | null;
      after?: string | null;
      personId?: string | null;
      relationshipTypeId?: string | null;
      state?: string | null;
      sensitivity?: string | null;
      activeAt?: string | Date | null;
    }): Promise<Connection<RelationshipRow>> {
      const page = normalizePagination(input);
      const activeAt = input.activeAt ? new Date(input.activeAt) : null;
      if (activeAt && Number.isNaN(activeAt.getTime()))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The relationship filter is invalid.",
        );
      const decoded = decode(page.after, "relationship-created-desc");
      const cursor =
        decoded && typeof decoded.t === "string"
          ? { createdAt: new Date(decoded.t), id: decoded.i as string }
          : null;
      if (cursor && Number.isNaN(cursor.createdAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
      const chunkSize = Math.min(101, page.first + 1);
      const rows = await repository.list({
        workspaceId: context.workspaceId,
        limit: chunkSize,
        personId: input.personId,
        cursor,
        visibility: relationshipVisibility,
        relationshipTypeId: input.relationshipTypeId,
        state: input.state as RelationshipRow["state"] | null | undefined,
        sensitivity: input.sensitivity as
          RelationshipRow["sensitivity"] | null | undefined,
        activeAt,
      });
      const nodes = rows.slice(0, page.first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last
            ? encode({
                o: "relationship-created-desc",
                t: last.createdAt.toISOString(),
                i: last.id,
              })
            : null,
        },
      };
    },
    async create(input: {
      idempotencyKey?: string | null;
      sourcePersonId: string;
      targetPersonId: string;
      relationshipTypeId: string;
      labelOverride?: string | null;
      strength?: number | null;
      confidence?: number | null;
      state?: string | null;
      sensitivity?: string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      validFrom?: string | Date | null;
      validUntil?: string | Date | null;
      metadata?: unknown;
    }): Promise<MutationOutcome<RelationshipRow>> {
      await Promise.all([
        requirePerson(input.sourcePersonId),
        requirePerson(input.targetPersonId),
      ]);
      const issues: ValidationIssue[] = [];
      const metadata = validateBoundedJson(input.metadata ?? {}, {
        objectOnly: true,
        path: ["metadata"],
      });
      issues.push(...metadata.issues);
      const strength = validateUnitDecimal(input.strength, {
        min: 0,
        max: 1,
        path: ["strength"],
      });
      const confidence = validateUnitDecimal(input.confidence ?? 1, {
        min: 0,
        max: 1,
        path: ["confidence"],
      });
      issues.push(...strength.issues, ...confidence.issues);
      const temporal = validateTemporal({
        semantics: input.temporalSemantics ?? "unknown",
        precision: input.temporalPrecision ?? "unknown",
        earliest: input.validFrom,
        latest: input.validUntil,
      });
      issues.push(...temporal.issues);
      const sensitivity = (input.sensitivity ?? "internal").toLowerCase();
      if (
        !["public", "internal", "confidential", "restricted"].includes(
          sensitivity,
        )
      )
        issues.push({
          path: ["sensitivity"],
          code: "INVALID_ENUM",
          message: "Invalid sensitivity.",
        });
      let labelOverride: string | null = null;
      if (input.labelOverride) {
        const label = normalizeHumanText(input.labelOverride, {
          path: ["labelOverride"],
          min: 1,
          max: 300,
        });
        issues.push(...label.issues);
        labelOverride = label.value ?? null;
      }
      const state = validateRelationshipState(input.state ?? "asserted");
      issues.push(...state.issues);
      if (issues.length) return invalid(issues);
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent relationship creation is not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + RELATIONSHIP_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "relationship.create.graphql",
          requestMaterial: {
            confidence: confidence.value ?? "1",
            labelOverride,
            metadata: metadata.value as CanonicalRequestMaterial,
            relationshipTypeId: input.relationshipTypeId,
            sensitivity,
            sourcePersonId: input.sourcePersonId,
            state: state.value!,
            strength: strength.value ?? null,
            targetPersonId: input.targetPersonId,
            temporalPrecision: temporal.value!.precision,
            temporalSemantics: temporal.value!.semantics,
            validFrom: temporal.value!.earliest?.toISOString() ?? null,
            validUntil: temporal.value!.latest?.toISOString() ?? null,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["relationship:create", "person:read"],
          async (scopedContext) => {
            const outcome = await createRelationshipsService(
              scopedContext,
            ).create({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The relationship could not be created.",
              );
            }
            return {
              relationshipId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayRelationship(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      return writeTransaction(context, async (transaction) => {
        const scoped = createRelationshipsRepository(
          transaction as unknown as typeof context.database,
        );
        const type = await scoped.getTypeForUpdate({
          workspaceId: context.workspaceId,
          id: input.relationshipTypeId,
        });
        if (!type || type.state !== "active")
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        const [source, target] = canonicalizeRelationshipEndpoints(
          input.sourcePersonId,
          input.targetPersonId,
          type.directed,
        );
        if (source === target && !type.allowsSelf)
          return invalid([
            {
              path: ["targetPersonId"],
              code: "SELF_NOT_ALLOWED",
              message:
                "This relationship type does not allow self relationships.",
            },
          ]);
        const schema = validateJsonSchema(
          `${context.workspaceId}:${type.id}:${type.version}`,
          type.metadataSchema,
          metadata.value,
        );
        if (schema.issues.some((item) => item.code === "INVALID_STORED_SCHEMA"))
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The relationship type is not usable.",
          );
        if (schema.issues.length) return invalid(schema.issues);
        const endpointIds = [...new Set([source, target])];
        const endpoints = await scoped.getPeopleForUpdate({
          workspaceId: context.workspaceId,
          ids: endpointIds,
        });
        if (
          endpoints.length !== endpointIds.length ||
          endpoints.some(
            (endpoint) =>
              endpoint.status === "archived" ||
              endpoint.status === "merged" ||
              endpoint.workspaceId !== context.workspaceId,
          ) ||
          !(
            await Promise.all(
              endpoints.map((endpoint) =>
                canAccessResource(
                  transaction as unknown as typeof context.database,
                  context,
                  {
                    id: endpoint.id,
                    lockGrants: true,
                    resourceKind: "person",
                    sensitivity: endpoint.sensitivity,
                  },
                ),
              ),
            )
          ).every(Boolean)
        )
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        if (
          await scoped.multiplicityConflicts({
            workspaceId: context.workspaceId,
            typeId: type.id,
            sourceId: source,
            targetId: target,
            multiplicity: type.allowedMultiplicity,
            directed: type.directed,
          })
        )
          return conflict<RelationshipRow>();
        const now = new Date();
        const created = await scoped.create({
          workspaceId: context.workspaceId,
          value: {
            id: newId(),
            sourcePersonId: source,
            targetPersonId: target,
            relationshipTypeId: type.id,
            labelOverride,
            strength: strength.value,
            confidence: confidence.value ?? "1",
            state: state.value!,
            sensitivity: sensitivity as RelationshipRow["sensitivity"],
            temporalSemantics: temporal.value!
              .semantics as RelationshipRow["temporalSemantics"],
            temporalPrecision: temporal.value!
              .precision as RelationshipRow["temporalPrecision"],
            validFrom: temporal.value!.earliest,
            validUntil: temporal.value!.latest,
            metadata: metadata.value,
            createdAt: now,
            createdBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        await audit.write(transaction as unknown as typeof context.database, {
          action: "relationship.create",
          resourceKind: "relationship",
          resourceId: created.id,
          sensitivity: created.sensitivity,
          changedFields: [
            "sourcePersonId",
            "targetPersonId",
            "relationshipTypeId",
            "metadata",
            "state",
            "sensitivity",
          ],
          metadata: {
            state: created.state,
            sensitivity: created.sensitivity,
            version: created.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: created.id,
            sourceKind: "relationship",
            sourceVersion: created.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return { resource: created, issues: [], code: null };
      });
    },
    async update(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
      labelOverride?: string | null;
      strength?: number | null;
      confidence?: number | null;
      state?: string | null;
      sensitivity?: string | null;
      temporalSemantics?: string | null;
      temporalPrecision?: string | null;
      validFrom?: string | Date | null;
      validUntil?: string | Date | null;
      metadata?: unknown;
    }): Promise<MutationOutcome<RelationshipRow>> {
      const current = await repository.get({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        (!current && input.idempotencyKey == null) ||
        (current && !(await visible(current)))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent relationship updates are not configured.",
          );
        }
        const fieldMaterial = (
          value: CanonicalRequestMaterial | undefined,
        ): CanonicalRequestMaterial =>
          value === undefined
            ? { present: false }
            : { present: true, value: value ?? null };
        const dateMaterial = (
          value: string | Date | null | undefined,
        ): CanonicalRequestMaterial =>
          fieldMaterial(value instanceof Date ? value.toISOString() : value);
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + RELATIONSHIP_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "relationship.update.graphql",
          requestMaterial: {
            confidence: fieldMaterial(input.confidence),
            expectedVersion: input.expectedVersion,
            id: input.id,
            labelOverride: fieldMaterial(
              input.labelOverride === undefined
                ? undefined
                : (input.labelOverride?.normalize("NFKC").trim() ?? null),
            ),
            metadata: fieldMaterial(
              input.metadata as CanonicalRequestMaterial | undefined,
            ),
            sensitivity: fieldMaterial(
              input.sensitivity === undefined
                ? undefined
                : (input.sensitivity?.toLowerCase() ?? null),
            ),
            state: fieldMaterial(
              input.state === undefined
                ? undefined
                : (input.state?.trim().toLowerCase() ?? null),
            ),
            strength: fieldMaterial(input.strength),
            temporalPrecision: dateMaterial(input.temporalPrecision),
            temporalSemantics: dateMaterial(input.temporalSemantics),
            validFrom: dateMaterial(input.validFrom),
            validUntil: dateMaterial(input.validUntil),
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["relationship:update"],
          async (scopedContext) => {
            const outcome = await createRelationshipsService(
              scopedContext,
            ).update({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                outcome.code === "CONFLICT" ? "CONFLICT" : "VALIDATION_FAILED",
                "The relationship could not be updated.",
              );
            }
            return {
              relationshipId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayRelationship(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      return writeTransaction(context, async (transaction) => {
        const scoped = createRelationshipsRepository(
          transaction as unknown as typeof context.database,
        );
        const locked = await scoped.getForUpdate({
          workspaceId: context.workspaceId,
          id: input.id,
        });
        if (
          !locked ||
          !(await canAccessResource(
            transaction as unknown as typeof context.database,
            context,
            {
              id: locked.id,
              resourceKind: "relationship",
              sensitivity: locked.sensitivity,
            },
          ))
        )
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        if (locked.version !== input.expectedVersion)
          return conflict<RelationshipRow>(locked.version);
        const type = await scoped.getTypeForUpdate({
          workspaceId: context.workspaceId,
          id: locked.relationshipTypeId,
        });
        if (!type || type.state !== "active")
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "The relationship type is not usable.",
          );
        const patch: Record<string, unknown> = {
          updatedAt: new Date(),
          updatedBy: context.actor.principalId,
        };
        const issues: ValidationIssue[] = [];
        const changed: string[] = [];
        if (input.labelOverride !== undefined) {
          if (input.labelOverride === null || input.labelOverride.trim() === "")
            patch.labelOverride = null;
          else {
            const label = normalizeHumanText(input.labelOverride, {
              path: ["labelOverride"],
              min: 1,
              max: 300,
            });
            issues.push(...label.issues);
            if (label.issues.length === 0) patch.labelOverride = label.value;
          }
          changed.push("labelOverride");
        }
        for (const [key, value] of [
          ["strength", input.strength],
          ["confidence", input.confidence],
        ] as const)
          if (value !== undefined) {
            const checked = validateUnitDecimal(value, {
              min: 0,
              max: 1,
              path: [key],
            });
            issues.push(...checked.issues);
            if (checked.issues.length === 0) patch[key] = checked.value;
            changed.push(key);
          }
        if (input.state !== undefined) {
          const state = validateRelationshipState(input.state, locked.state);
          issues.push(...state.issues);
          if (state.issues.length === 0) patch.state = state.value;
          changed.push("state");
        } else {
          issues.push(
            ...validateRelationshipState(locked.state, locked.state).issues,
          );
        }
        if (input.sensitivity !== undefined) {
          const value = input.sensitivity?.toLowerCase();
          if (
            !value ||
            !["public", "internal", "confidential", "restricted"].includes(
              value,
            )
          )
            issues.push({
              path: ["sensitivity"],
              code: "INVALID_ENUM",
              message: "Invalid sensitivity.",
            });
          else patch.sensitivity = value;
          changed.push("sensitivity");
        }
        const temporal = validateTemporal({
          semantics:
            input.temporalSemantics === undefined
              ? locked.temporalSemantics
              : (input.temporalSemantics ?? "unknown"),
          precision:
            input.temporalPrecision === undefined
              ? locked.temporalPrecision
              : (input.temporalPrecision ?? "unknown"),
          earliest:
            input.validFrom === undefined ? locked.validFrom : input.validFrom,
          latest:
            input.validUntil === undefined
              ? locked.validUntil
              : input.validUntil,
        });
        issues.push(...temporal.issues);
        if (temporal.issues.length === 0) {
          if (input.temporalSemantics !== undefined) {
            patch.temporalSemantics = temporal.value!.semantics;
            changed.push("temporalSemantics");
          }
          if (input.temporalPrecision !== undefined) {
            patch.temporalPrecision = temporal.value!.precision;
            changed.push("temporalPrecision");
          }
          if (input.validFrom !== undefined) {
            patch.validFrom = temporal.value!.earliest;
            changed.push("validFrom");
          }
          if (input.validUntil !== undefined) {
            patch.validUntil = temporal.value!.latest;
            changed.push("validUntil");
          }
        }
        const metadata = validateBoundedJson(
          input.metadata === undefined ? locked.metadata : input.metadata,
          { objectOnly: true, path: ["metadata"] },
        );
        issues.push(...metadata.issues);
        if (metadata.issues.length === 0) {
          const schema = validateJsonSchema(
            `${context.workspaceId}:${type.id}:${type.version}`,
            type.metadataSchema,
            metadata.value,
          );
          if (
            schema.issues.some((item) => item.code === "INVALID_STORED_SCHEMA")
          )
            throw createGraphQLError(
              "PRECONDITION_FAILED",
              "The relationship type is not usable.",
            );
          issues.push(...schema.issues);
          if (input.metadata !== undefined && schema.issues.length === 0)
            patch.metadata = metadata.value;
        }
        if (input.metadata !== undefined) changed.push("metadata");
        if (issues.length) return invalid<RelationshipRow>(issues);
        const updated = await scoped.updateIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch,
        });
        if (!updated) return conflict<RelationshipRow>(locked.version);
        await audit.write(transaction as unknown as typeof context.database, {
          action: "relationship.update",
          resourceKind: "relationship",
          resourceId: updated.id,
          sensitivity: updated.sensitivity,
          changedFields: changed,
          metadata: {
            state: updated.state,
            sensitivity: updated.sensitivity,
            version: updated.version,
          },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "upsert",
            sourceId: updated.id,
            sourceKind: "relationship",
            sourceVersion: updated.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return { resource: updated, issues: [], code: null };
      });
    },
    async archive(input: {
      id: string;
      expectedVersion: number;
      idempotencyKey?: string | null;
    }): Promise<MutationOutcome<RelationshipRow>> {
      const current = await repository.get({
        workspaceId: context.workspaceId,
        id: input.id,
      });
      if (
        (!current && input.idempotencyKey == null) ||
        (current && !(await visible(current)))
      )
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested resource was not found.",
        );
      if (input.idempotencyKey != null) {
        const secret = context.idempotencyHmacKey;
        if (!secret) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            "Idempotent relationship archives are not configured.",
          );
        }
        const idempotency = derivePrincipalResearchIdempotency(context, {
          expiresAt: new Date(Date.now() + RELATIONSHIP_IDEMPOTENCY_TTL_MS),
          idempotencyKey: input.idempotencyKey,
          operation: "relationship.archive.graphql",
          requestMaterial: {
            expectedVersion: input.expectedVersion,
            id: input.id,
          },
          secret,
        });
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency,
          ["relationship:delete"],
          async (scopedContext) => {
            const outcome = await createRelationshipsService(
              scopedContext,
            ).archive({ ...input, idempotencyKey: null });
            if (!outcome.resource) {
              throw createGraphQLError(
                "CONFLICT",
                "The relationship could not be archived.",
              );
            }
            return {
              relationshipId: outcome.resource.id,
              version: outcome.resource.version,
            };
          },
        );
        return {
          resource: await replayRelationship(executed.responseReference),
          issues: [],
          code: null,
        };
      }
      const now = new Date();
      const row = await writeTransaction(context, async (transaction) => {
        const scoped = createRelationshipsRepository(
          transaction as unknown as typeof context.database,
        );
        const archived = await scoped.updateIfVersion({
          workspaceId: context.workspaceId,
          id: input.id,
          expectedVersion: input.expectedVersion,
          patch: {
            deletedAt: now,
            deletedBy: context.actor.principalId,
            updatedAt: now,
            updatedBy: context.actor.principalId,
          },
        });
        if (!archived) return null;
        await audit.write(transaction as unknown as typeof context.database, {
          action: "relationship.archive",
          resourceKind: "relationship",
          resourceId: archived.id,
          sensitivity: archived.sensitivity,
          changedFields: ["deletedAt"],
          metadata: { version: archived.version },
        });
        await applySearchIndexMaintenance(context, transaction, [
          {
            action: "remove",
            sourceId: archived.id,
            sourceKind: "relationship",
            sourceVersion: archived.version,
            workspaceId: context.workspaceId,
          },
        ]);
        return archived;
      });
      return row
        ? { resource: row, issues: [], code: null }
        : conflict(current.version);
    },
  };
}

export type RelationshipsService = ReturnType<
  typeof createRelationshipsService
>;
