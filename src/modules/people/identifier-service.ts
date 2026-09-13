import { and, eq, isNull, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { people, personIdentifiers } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  normalizeProtectedExactV1,
  prepareProtectedExactV1,
} from "@/lib/security/protected-exact";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  runResearchTransaction,
  type CanonicalRequestMaterial,
} from "@/modules/audit/transactions";
import {
  projectPersonIdentifier,
  type MutationOutcome,
  type PersonIdentifierView,
} from "./service";
import type { PersonIdentifierRow } from "./repository";

type IdentifierFields = {
  namespace: string;
  identifierType: string;
  value: string;
  issuer?: string | null;
  sensitivity?: string | null;
  verificationState?: string | null;
  validFrom?: Date | string | null;
  validUntil?: Date | string | null;
};
type CreateInput = IdentifierFields & {
  personId: string;
  idempotencyKey?: string | null;
};
type UpdateInput = Partial<IdentifierFields> & {
  id: string;
  expectedVersion: number;
  idempotencyKey?: string | null;
};
type ArchiveInput = Pick<
  UpdateInput,
  "id" | "expectedVersion" | "idempotencyKey"
>;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
class IdentifierNotVisible extends Error {}
function invalid(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The identifier fields are invalid.",
  );
}
function date(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return invalid();
  return parsed;
}
function metadata(input: Omit<IdentifierFields, "value">) {
  const identifierType = input.identifierType.normalize("NFKC").trim();
  const issuer = input.issuer?.normalize("NFKC").trim() || null;
  const sensitivity = input.sensitivity ?? "confidential";
  const verificationState = input.verificationState ?? "unverified";
  const validFrom = date(input.validFrom);
  const validUntil = date(input.validUntil);
  if (
    !identifierType ||
    identifierType.length > 100 ||
    (issuer?.length ?? 0) > 300 ||
    !["public", "internal", "confidential", "restricted"].includes(
      sensitivity,
    ) ||
    !["unverified", "verified", "disputed", "revoked", "unknown"].includes(
      verificationState,
    ) ||
    (validFrom && validUntil && validUntil < validFrom)
  )
    return invalid();
  return {
    identifierType,
    issuer,
    sensitivity: sensitivity as PersonIdentifierRow["sensitivity"],
    verificationState:
      verificationState as PersonIdentifierRow["verificationState"],
    validFrom,
    validUntil,
  };
}

export function prepareIdentifierWrite(
  input: IdentifierFields,
  context: Pick<
    ResearchServiceContext,
    "workspaceId" | "protectedExactRuntime"
  >,
) {
  const fields = metadata(input);
  const lookup = {
    kind: "PERSON_IDENTIFIER" as const,
    namespace: input.namespace,
    value: input.value,
  };
  let normalized: ReturnType<typeof normalizeProtectedExactV1>;
  try {
    normalized = normalizeProtectedExactV1(lookup);
  } catch {
    return invalid();
  }
  if (fields.sensitivity === "public")
    return {
      ...fields,
      namespace: normalized.namespace!,
      normalizedValue: normalized.canonicalValue,
      encryptedRawValue: null,
      blindIndex: null,
      blindIndexVersion: 1 as const,
    };
  const runtime = context.protectedExactRuntime;
  if (
    !runtime ||
    !/^[0-9a-f]{64}$/iu.test(runtime.encryptionKey) ||
    !/^[0-9a-f]{64}$/iu.test(runtime.blindIndexKey)
  )
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Protected identifier storage is not configured.",
    );
  const protectedValue = prepareProtectedExactV1({
    ...runtime,
    workspaceId: context.workspaceId,
    lookup,
  });
  return {
    ...fields,
    namespace: protectedValue.namespace!,
    normalizedValue: null,
    encryptedRawValue: protectedValue.encryptedValue,
    blindIndex: protectedValue.blindIndex,
    blindIndexVersion: protectedValue.blindIndexVersion,
  };
}

export function createIdentifierService(context: ResearchServiceContext) {
  async function person(scoped: ResearchServiceContext, id: string) {
    const [row] = await scoped.database
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, scoped.workspaceId),
          eq(people.id, id),
          isNull(people.deletedAt),
          resourceVisibilitySql(scoped, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
        ),
      )
      .limit(1)
      .for("update");
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
  }
  async function read(
    scoped: ResearchServiceContext,
    id: string,
    archived = false,
  ) {
    const [row] = await scoped.database
      .select()
      .from(personIdentifiers)
      .where(
        and(
          eq(personIdentifiers.workspaceId, scoped.workspaceId),
          eq(personIdentifiers.id, id),
          archived ? undefined : isNull(personIdentifiers.deletedAt),
          resourceVisibilitySql(scoped, {
            resourceKind: "personIdentifier",
            id: personIdentifiers.id,
            sensitivity: personIdentifiers.sensitivity,
          }),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    await person(scoped, row.personId);
    return row;
  }
  async function executeMutation(
    action: "create" | "update" | "archive",
    input: CreateInput | UpdateInput | ArchiveInput,
  ): Promise<MutationOutcome<PersonIdentifierView>> {
    const permission = action === "archive" ? "person:delete" : "person:update";
    if (!context.permissions.has(permission))
      throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
    if (
      "expectedVersion" in input &&
      (!Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1 ||
        input.expectedVersion > 2147483647)
    )
      return invalid();
    const write = async (scoped: ResearchServiceContext) => {
      const now = new Date();
      let row: PersonIdentifierRow | undefined;
      if (action === "create") {
        const create = input as CreateInput;
        await person(scoped, create.personId);
        const fields = prepareIdentifierWrite(create, scoped);
        [row] = await scoped.database
          .insert(personIdentifiers)
          .values({
            ...fields,
            id: newId(),
            workspaceId: scoped.workspaceId,
            personId: create.personId,
            createdBy: scoped.actor.principalId,
            updatedBy: scoped.actor.principalId,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      } else {
        const update = input as UpdateInput;
        const existing = await read(scoped, update.id);
        if (existing.version !== update.expectedVersion)
          throw createGraphQLError(
            "CONFLICT",
            "The identifier has changed. Refresh before retrying.",
          );
        let patch: Partial<typeof personIdentifiers.$inferInsert>;
        if (action === "archive")
          patch = { deletedAt: now, deletedBy: scoped.actor.principalId };
        else {
          const merged = {
            ...existing,
            ...Object.fromEntries(
              Object.entries(update).filter(([, value]) => value !== undefined),
            ),
          };
          const fields = metadata(merged);
          const namespace = merged.namespace
            .normalize("NFKC")
            .trim()
            .toLowerCase();
          if (!/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(namespace)) return invalid();
          if (
            update.value !== undefined ||
            namespace !== existing.namespace ||
            fields.sensitivity !== existing.sensitivity
          ) {
            // Never decrypt a protected value for edits or reclassification.
            const value =
              update.value ??
              (existing.sensitivity === "public"
                ? existing.normalizedValue
                : null);
            if (!value) return invalid();
            patch = prepareIdentifierWrite({ ...merged, value }, scoped);
          } else patch = { ...fields, namespace };
        }
        [row] = await scoped.database
          .update(personIdentifiers)
          .set({
            ...patch,
            updatedAt: now,
            updatedBy: scoped.actor.principalId,
            version: sql`${personIdentifiers.version} + 1`,
          })
          .where(
            and(
              eq(personIdentifiers.workspaceId, scoped.workspaceId),
              eq(personIdentifiers.id, update.id),
              eq(personIdentifiers.personId, existing.personId),
              eq(personIdentifiers.version, update.expectedVersion),
              isNull(personIdentifiers.deletedAt),
            ),
          )
          .returning();
      }
      if (!row)
        throw createGraphQLError(
          "CONFLICT",
          "The identifier has changed. Refresh before retrying.",
        );
      if (action !== "archive") {
        // Do not commit a write whose resulting sensitivity/purpose is hidden
        // from the caller. Throw inside the transaction so audit/idempotency
        // and the identifier write roll back together.
        const [visibleResult] = await scoped.database
          .select({ id: personIdentifiers.id })
          .from(personIdentifiers)
          .where(
            and(
              eq(personIdentifiers.workspaceId, scoped.workspaceId),
              eq(personIdentifiers.id, row.id),
              eq(personIdentifiers.personId, row.personId),
              isNull(personIdentifiers.deletedAt),
              resourceVisibilitySql(scoped, {
                resourceKind: "personIdentifier",
                id: personIdentifiers.id,
                sensitivity: personIdentifiers.sensitivity,
              }),
            ),
          )
          .limit(1);
        if (!visibleResult) throw new IdentifierNotVisible();
        await person(scoped, row.personId);
      }
      await createAuditService(scoped).write(scoped.database, {
        action: `personIdentifier.${action}`,
        resourceKind: "personIdentifier",
        resourceId: row.id,
        sensitivity: row.sensitivity,
        changedFields:
          action === "archive"
            ? ["deletedAt"]
            : Object.keys(input).filter(
                (key) =>
                  ![
                    "id",
                    "personId",
                    "expectedVersion",
                    "idempotencyKey",
                  ].includes(key),
              ),
        metadata: { personId: row.personId, version: row.version },
      });
      return row;
    };
    if (input.idempotencyKey == null) {
      const row = await runResearchTransaction(
        context,
        { requiredPermissions: [permission] },
        write,
      );
      return { resource: projectPersonIdentifier(row), issues: [], code: null };
    }
    if (!context.idempotencyHmacKey)
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "Identifier mutation idempotency is not configured.",
      );
    const material: Record<string, CanonicalRequestMaterial> = {};
    for (const [key, value] of Object.entries(input)) {
      if (key !== "idempotencyKey" && value !== undefined)
        material[key] = value instanceof Date ? value.toISOString() : value;
    }
    const result = await runPrincipalIdempotentResearchWrite(
      context,
      derivePrincipalResearchIdempotency(context, {
        operation: `person_identifier.${action}.graphql`,
        idempotencyKey: input.idempotencyKey,
        secret: context.idempotencyHmacKey,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        requestMaterial: material,
      }),
      [permission],
      async (scoped) => {
        const row = await write(scoped);
        return { identifierId: row.id, version: row.version };
      },
    );
    const ref = result.responseReference;
    if (
      Object.keys(ref).sort().join(":") !== "identifierId:version" ||
      typeof ref.identifierId !== "string" ||
      !UUID.test(ref.identifierId) ||
      typeof ref.version !== "number" ||
      !Number.isSafeInteger(ref.version) ||
      ref.version < 1
    )
      return invalid();
    return runResearchTransaction(
      context,
      { requiredPermissions: [permission] },
      async (scoped) => {
        const row = await read(
          scoped,
          ref.identifierId as string,
          action === "archive",
        );
        if (row.version !== ref.version)
          throw createGraphQLError(
            "CONFLICT",
            "The idempotent operation response is no longer current.",
          );
        return {
          resource: projectPersonIdentifier(row),
          issues: [],
          code: null,
        };
      },
    );
  }
  async function mutate(
    action: "create" | "update" | "archive",
    input: CreateInput | UpdateInput | ArchiveInput,
  ): Promise<MutationOutcome<PersonIdentifierView>> {
    try {
      return await executeMutation(action, input);
    } catch (error) {
      if (error instanceof IdentifierNotVisible)
        return { resource: null, issues: [], code: "NOT_VISIBLE" };
      throw error;
    }
  }
  return {
    createIdentifier: (input: CreateInput) => mutate("create", input),
    updateIdentifier: (input: UpdateInput) => mutate("update", input),
    archiveIdentifier: (input: ArchiveInput) => mutate("archive", input),
  };
}
