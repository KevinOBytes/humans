import { newId } from "@/db/id";
import { createGraphQLError } from "@/graphql/errors";
import {
  canAccessResource,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  applySearchIndexMaintenance,
  getTrustedWorkerAuditContext,
  withResearchWriteTransaction,
} from "@/modules/audit/transactions";
import { parseImportMappingEnvelope } from "@/modules/imports/mapper";
import type {
  RelationshipEndpointMapping,
  RelationshipImportMapping,
} from "@/modules/imports/types";

import {
  createImportIdentityRepository,
  type ImportIdentityExternalRecord,
  type ImportIdentityName,
} from "./import-identity-repository";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SOURCE_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const UNSAFE_EXTERNAL_ID_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const MAX_EXTERNAL_ID_BYTES = 512;
const PERSON_NAME_KINDS = new Set([
  "legal",
  "preferred",
  "birth",
  "married",
  "former",
  "alias",
  "transliteration",
  "other",
] as const);
type PersonNameKind =
  | "legal"
  | "preferred"
  | "birth"
  | "married"
  | "former"
  | "alias"
  | "transliteration"
  | "other";

export type AttachedPersonIdentity = Readonly<{
  externalRecord: ImportIdentityExternalRecord;
  personName: ImportIdentityName;
}>;

type StagedPersonIdentity = Readonly<{
  displayName: string;
  primaryNameKind: PersonNameKind;
  rowKey: string;
}>;

function invalid(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The import identity is invalid.",
  );
}

function forbidden(): never {
  throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

function notFound(): never {
  throw createGraphQLError(
    "NOT_FOUND",
    "The requested resource was not found.",
  );
}

function conflict(): never {
  throw createGraphQLError(
    "CONFLICT",
    "The import identity conflicts with current state.",
  );
}

function requireCanonicalExternalId(value: unknown): string {
  if (typeof value !== "string") return invalid();
  const normalized = value.normalize("NFKC").trim();
  if (
    !normalized ||
    normalized !== value ||
    Buffer.byteLength(normalized, "utf8") > MAX_EXTERNAL_ID_BYTES ||
    UNSAFE_EXTERNAL_ID_PATTERN.test(normalized)
  ) {
    return invalid();
  }
  return normalized;
}

function mappingPersonNameKind(value: unknown): PersonNameKind | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const definition = (value as Record<string, unknown>).definition;
  if (
    !definition ||
    typeof definition !== "object" ||
    Array.isArray(definition)
  ) {
    return null;
  }
  const mapping = definition as Record<string, unknown>;
  const person = mapping.person;
  if (
    mapping.recordKind !== "PERSON" ||
    !person ||
    typeof person !== "object" ||
    Array.isArray(person)
  ) {
    return null;
  }
  const kind = (person as Record<string, unknown>).primaryNameKind;
  return typeof kind === "string" &&
    PERSON_NAME_KINDS.has(kind as PersonNameKind)
    ? (kind as PersonNameKind)
    : null;
}

function storedImportDefinition(value: unknown): {
  definition: ReturnType<typeof parseImportMappingEnvelope>;
  mode: "COMMIT" | "DRY_RUN";
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const envelope = value as Record<string, unknown>;
  const legacyKeys = [
    "definition",
    "mappingHash",
    "mappingId",
    "mappingVersion",
    "mode",
    "requestHash",
  ];
  const snapshotKeys = [...legacyKeys, "fileChecksum", "fileSize"];
  const keys = Object.keys(envelope);
  const hasExactKeys = [legacyKeys, snapshotKeys].some(
    (expected) =>
      keys.length === expected.length &&
      expected.every((key) => Object.hasOwn(envelope, key)),
  );
  if (
    !hasExactKeys ||
    typeof envelope.mappingHash !== "string" ||
    !SOURCE_HASH_PATTERN.test(envelope.mappingHash) ||
    typeof envelope.mappingId !== "string" ||
    !UUID_PATTERN.test(envelope.mappingId) ||
    !Number.isSafeInteger(envelope.mappingVersion) ||
    Number(envelope.mappingVersion) < 1 ||
    (envelope.mode !== "COMMIT" && envelope.mode !== "DRY_RUN") ||
    typeof envelope.requestHash !== "string" ||
    !SOURCE_HASH_PATTERN.test(envelope.requestHash) ||
    (keys.length === snapshotKeys.length &&
      (typeof envelope.fileChecksum !== "string" ||
        !/^sha256:[0-9a-f]{64}$/u.test(envelope.fileChecksum) ||
        !Number.isSafeInteger(envelope.fileSize) ||
        Number(envelope.fileSize) < 0))
  ) {
    return null;
  }
  try {
    return {
      definition: parseImportMappingEnvelope(envelope.definition),
      mode: envelope.mode,
    };
  } catch {
    return null;
  }
}

type ProjectedRelationshipEndpoint =
  | Readonly<{ kind: "PERSON_ID"; personId: string }>
  | Readonly<{
      externalId: string;
      kind: "EXTERNAL_KEY";
      personImportId: string;
    }>;

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string")
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const ownKeys = Object.keys(record).sort();
  return ownKeys.length === keys.length &&
    ownKeys.every((key, index) => key === [...keys].sort()[index])
    ? record
    : null;
}

function projectedRelationshipEndpoint(input: {
  endpoint: "source" | "target";
  mapping: RelationshipImportMapping;
  normalizedPayload: unknown;
}): {
  mapped: RelationshipEndpointMapping;
  projected: ProjectedRelationshipEndpoint;
} | null {
  const row = exactRecord(input.normalizedPayload, [
    "defaults",
    "kind",
    "relationship",
    "rowKey",
  ]);
  if (!row || row.kind !== "RELATIONSHIP") return null;
  const relationship = row.relationship;
  if (!relationship || typeof relationship !== "object") return null;
  const relationshipRecord = relationship as Record<string, unknown>;
  if (relationshipRecord.typeId !== input.mapping.relationship.typeId) {
    return null;
  }
  const mapped =
    input.endpoint === "source"
      ? input.mapping.relationship.sourcePerson
      : input.mapping.relationship.targetPerson;
  const value =
    input.endpoint === "source"
      ? relationshipRecord.sourcePerson
      : relationshipRecord.targetPerson;
  if (mapped.kind === "PERSON_ID") {
    const projected = exactRecord(value, ["kind", "personId"]);
    return projected?.kind === "PERSON_ID" &&
      typeof projected.personId === "string" &&
      UUID_PATTERN.test(projected.personId) &&
      projected.personId === projected.personId.toLowerCase()
      ? {
          mapped,
          projected: {
            kind: "PERSON_ID",
            personId: projected.personId,
          },
        }
      : null;
  }
  const projected = exactRecord(value, [
    "externalId",
    "kind",
    "personImportId",
  ]);
  if (
    projected?.kind !== "EXTERNAL_KEY" ||
    projected.personImportId !== mapped.personImportId ||
    typeof projected.externalId !== "string"
  ) {
    return null;
  }
  let externalId: string;
  try {
    externalId = requireCanonicalExternalId(projected.externalId);
  } catch {
    return null;
  }
  return {
    mapped,
    projected: {
      externalId,
      kind: "EXTERNAL_KEY",
      personImportId: mapped.personImportId,
    },
  };
}

function stagedPersonIdentity(value: unknown): StagedPersonIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const person = row.person;
  if (!person || typeof person !== "object" || Array.isArray(person)) {
    return null;
  }
  const displayName = (person as Record<string, unknown>).displayName;
  const primaryNameKind = row.primaryNameKind;
  if (
    row.kind !== "PERSON" ||
    typeof row.rowKey !== "string" ||
    typeof displayName !== "string" ||
    typeof primaryNameKind !== "string" ||
    !PERSON_NAME_KINDS.has(primaryNameKind as PersonNameKind)
  ) {
    return null;
  }
  return {
    displayName,
    primaryNameKind: primaryNameKind as PersonNameKind,
    rowKey: row.rowKey,
  };
}

function sourceSystem(importId: string): string {
  return `humans-import:${importId}`;
}

export function createImportIdentityService(context: ResearchServiceContext) {
  return {
    async attachPersonIdentity(input: {
      personId: string;
    }): Promise<AttachedPersonIdentity> {
      const trusted = getTrustedWorkerAuditContext(context);
      if (!trusted || trusted.operation !== "PERSON") return forbidden();
      if (!UUID_PATTERN.test(input.personId)) return invalid();

      return withResearchWriteTransaction(context, async (database) => {
        const repository = createImportIdentityRepository(database);
        const audit = createAuditService(context);
        const locked = await repository.lockPersonAndRunningImport({
          importId: trusted.importId,
          importRowId: trusted.importRowId,
          personId: input.personId.toLowerCase(),
          workspaceId: trusted.workspaceId,
        });
        const staged = locked
          ? stagedPersonIdentity(locked.importRow.normalizedPayload)
          : null;
        if (
          !locked ||
          !staged ||
          mappingPersonNameKind(locked.importMapping) !==
            staged.primaryNameKind ||
          !SOURCE_HASH_PATTERN.test(locked.importRow.sourceHash) ||
          staged.displayName !== locked.person.displayName ||
          !(await repository.hasCurrentWorkerPersonCreation({
            importId: trusted.importId,
            importRowId: trusted.importRowId,
            jobId: trusted.jobId,
            personId: locked.person.id,
            requestId: trusted.requestId,
            workspaceId: trusted.workspaceId,
          }))
        ) {
          return notFound();
        }
        const externalId = requireCanonicalExternalId(staged.rowKey);
        await repository.serializeExternalKey({
          externalId,
          importId: trusted.importId,
          workspaceId: trusted.workspaceId,
        });

        const namespace = sourceSystem(trusted.importId);
        const existing = await repository.getExternalRecordForUpdate({
          externalId,
          sourceSystem: namespace,
          workspaceId: trusted.workspaceId,
        });
        if (existing) {
          if (
            existing.deletedAt !== null ||
            existing.importId !== trusted.importId ||
            existing.personId !== locked.person.id ||
            existing.sourceHash !== locked.importRow.sourceHash ||
            !locked.person.primaryNameId
          ) {
            return conflict();
          }
          const name = await repository.getPersonNameForUpdate({
            id: locked.person.primaryNameId,
            personId: locked.person.id,
            workspaceId: trusted.workspaceId,
          });
          if (
            !name ||
            name.kind !== staged.primaryNameKind ||
            name.fullName !== locked.person.displayName
          ) {
            return conflict();
          }
          return Object.freeze({ externalRecord: existing, personName: name });
        }
        if (locked.person.primaryNameId) return conflict();

        const now = new Date();
        const name = await repository.insertPersonName({
          id: newId(),
          workspaceId: trusted.workspaceId,
          personId: locked.person.id,
          kind: staged.primaryNameKind,
          fullName: locked.person.displayName,
          sensitivity: locked.person.sensitivity,
          state: "asserted",
          createdAt: now,
          createdBy: trusted.principalId,
          updatedAt: now,
          updatedBy: trusted.principalId,
        });
        const updatedPerson = await repository.setPrimaryName({
          expectedVersion: locked.person.version,
          nameId: name.id,
          personId: locked.person.id,
          principalId: trusted.principalId,
          updatedAt: now,
          workspaceId: trusted.workspaceId,
        });
        if (!updatedPerson) return conflict();
        const external = await repository.insertExternalRecord({
          id: newId(),
          workspaceId: trusted.workspaceId,
          sourceSystem: namespace,
          externalType: "person",
          externalId,
          personId: locked.person.id,
          importId: trusted.importId,
          sourceHash: locked.importRow.sourceHash,
          lastSeenAt: now,
          createdAt: now,
          createdBy: trusted.principalId,
          updatedAt: now,
          updatedBy: trusted.principalId,
        });
        await audit.write(database, {
          action: "personName.create",
          changedFields: [
            "personId",
            "kind",
            "fullName",
            "sensitivity",
            "state",
          ],
          metadata: { version: name.version },
          resourceId: name.id,
          resourceKind: "personName",
          sensitivity: locked.person.sensitivity,
        });
        await audit.write(database, {
          action: "externalRecord.create",
          changedFields: [
            "personId",
            "importId",
            "sourceSystem",
            "externalType",
            "externalId",
            "sourceHash",
          ],
          metadata: { version: external.version },
          resourceId: external.id,
          resourceKind: "externalRecord",
          sensitivity: locked.person.sensitivity,
        });
        await applySearchIndexMaintenance(context, database, [
          {
            action: "upsert",
            sourceId: name.id,
            sourceKind: "person_name",
            sourceVersion: 1,
            workspaceId: trusted.workspaceId,
          },
          {
            action: "upsert",
            sourceId: updatedPerson.id,
            sourceKind: "person",
            sourceVersion: updatedPerson.version,
            workspaceId: trusted.workspaceId,
          },
        ]);
        return Object.freeze({ externalRecord: external, personName: name });
      });
    },

    async resolveRelationshipPerson(input: {
      endpoint: "source" | "target";
    }): Promise<string | null> {
      const trusted = getTrustedWorkerAuditContext(context);
      if (!trusted || trusted.operation !== "RELATIONSHIP") return forbidden();
      if (input.endpoint !== "source" && input.endpoint !== "target") {
        return invalid();
      }
      const repository = createImportIdentityRepository(context.database);
      const locked = await repository.lockRunningRelationshipImportRow({
        importId: trusted.importId,
        importRowId: trusted.importRowId,
        workspaceId: trusted.workspaceId,
      });
      const current = locked
        ? storedImportDefinition(locked.importMapping)
        : null;
      const endpoint =
        current?.definition.recordKind === "RELATIONSHIP"
          ? projectedRelationshipEndpoint({
              endpoint: input.endpoint,
              mapping: current.definition,
              normalizedPayload: locked!.normalizedPayload,
            })
          : null;
      if (!endpoint) return null;
      if (endpoint.projected.kind === "PERSON_ID") {
        const person = await repository.getPersonForShare({
          personId: endpoint.projected.personId,
          workspaceId: trusted.workspaceId,
        });
        return person &&
          (await canAccessResource(context.database, context, {
            id: person.id,
            lockGrants: true,
            resourceKind: "person",
            sensitivity: person.sensitivity,
          }))
          ? person.id
          : null;
      }
      const resolved = await repository.resolveCompletedPersonExternalKey({
        externalId: endpoint.projected.externalId,
        importId: endpoint.projected.personImportId,
        sourceSystem: sourceSystem(endpoint.projected.personImportId),
        workspaceId: trusted.workspaceId,
      });
      const referenced = resolved
        ? storedImportDefinition(resolved.importMapping)
        : null;
      if (
        !resolved ||
        referenced?.mode !== "COMMIT" ||
        referenced.definition.recordKind !== "PERSON" ||
        !(await canAccessResource(context.database, context, {
          id: resolved.person.id,
          lockGrants: true,
          resourceKind: "person",
          sensitivity: resolved.person.sensitivity,
        }))
      ) {
        return null;
      }
      return resolved.person.id;
    },
  };
}
