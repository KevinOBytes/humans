import { createHash, createHmac } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { factDefinitions } from "@/db/schema/facts";
import {
  files,
  importMappings,
  imports as importsTable,
  uploadSessions,
} from "@/db/schema/files";
import { relationshipTypes } from "@/db/schema/relationships";
import { createGraphQLError, publicErrorMessage } from "@/graphql/errors";
import type { RequestOperationLimiter } from "@/graphql/operation-limiter";
import type { ObjectStore } from "@/lib/storage/types";
import {
  createAuditService,
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { withResearchWriteTransaction } from "@/modules/audit/transactions";
import { createJobsService } from "@/modules/jobs/service";
import { equalJobHashes } from "@/modules/jobs/types";

import {
  parseImportMapping,
  parseImportMappingEnvelope,
  projectImportRow,
} from "./mapper";
import { parseImportStream } from "./parser";
import {
  createImportsRepository,
  type ImportMappingRow,
  type ImportRow,
  type ImportStagedRow,
} from "./repository";
import type { ImportFormat, ImportMapping, StoredImportMapping } from "./types";

const STAGE_BATCH_SIZE = 250;
const PREVIEW_LIMIT = 100;
const ISSUE_LIMIT = 200;
const ACTIVE_IMPORTS_ACTOR = 1;
const ACTIVE_IMPORTS_WORKSPACE = 3;
const PREPARE_LEASE_MS = 60_000;
const PREPARE_WAIT_MS = 25;

export type ImportServiceContext = ResearchServiceContext & {
  operationLimiter: RequestOperationLimiter;
};

export type ImportServiceRuntime = {
  encryptionKey: string;
  objectStore?: ObjectStore;
};

function forbidden(): never {
  throw createGraphQLError("FORBIDDEN", publicErrorMessage("FORBIDDEN"));
}

function requireSession(
  context: ImportServiceContext,
): asserts context is ImportServiceContext & {
  actor: Extract<ImportServiceContext["actor"], { type: "user" }>;
} {
  if (context.actor.type !== "user") return forbidden();
}

function requirePermission(
  context: ImportServiceContext,
  permission: string,
): void {
  if (!context.permissions.has(permission)) return forbidden();
}

function notFound(): never {
  throw createGraphQLError("NOT_FOUND", publicErrorMessage("NOT_FOUND"));
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Invalid canonical value");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object")
    throw new TypeError("Invalid canonical value");
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function secretBuffer(secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/iu.test(secret)) {
    throw new TypeError("Invalid import protection key");
  }
  return Buffer.from(secret, "hex");
}

function hmac(secret: string, purpose: string, value: string): string {
  return createHmac("sha256", secretBuffer(secret))
    .update(`humans:${purpose}:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function normalizedIdempotency(value: string): string {
  const normalized =
    typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 128) {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The idempotency key is invalid.",
    );
  }
  return normalized;
}

function mappingEnvelope(value: unknown): StoredImportMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Stored import mapping is invalid");
  }
  const record = value as Record<string, unknown>;
  const definition = parseImportMappingEnvelope(record.definition);
  if (
    (record.fileChecksum !== undefined &&
      typeof record.fileChecksum !== "string") ||
    (record.fileSize !== undefined && typeof record.fileSize !== "number") ||
    typeof record.mappingHash !== "string" ||
    typeof record.mappingId !== "string" ||
    typeof record.mappingVersion !== "number" ||
    (record.mode !== "COMMIT" && record.mode !== "DRY_RUN") ||
    typeof record.requestHash !== "string"
  ) {
    throw new Error("Stored import mapping is invalid");
  }
  return {
    definition,
    fileChecksum:
      typeof record.fileChecksum === "string" ? record.fileChecksum : undefined,
    fileSize: typeof record.fileSize === "number" ? record.fileSize : undefined,
    mappingHash: record.mappingHash,
    mappingId: record.mappingId,
    mappingVersion: record.mappingVersion,
    mode: record.mode,
    requestHash: record.requestHash,
  };
}

function pageCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.createdAt.toISOString(), i: row.id }),
  ).toString("base64url");
}

function parsePageCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const createdAt = new Date(String(parsed.t ?? ""));
    if (
      parsed.v !== 1 ||
      typeof parsed.i !== "string" ||
      !Number.isFinite(createdAt.getTime())
    ) {
      throw new Error("invalid");
    }
    return { createdAt, id: parsed.i };
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import cursor is invalid.",
    );
  }
}

function rowCursor(row: { id: string; rowNumber: number }): string {
  return Buffer.from(
    JSON.stringify({ v: 1, r: row.rowNumber, i: row.id }),
  ).toString("base64url");
}

function parseRowCursor(value?: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (
      parsed.v !== 1 ||
      !Number.isSafeInteger(parsed.r) ||
      Number(parsed.r) < 1 ||
      typeof parsed.i !== "string" ||
      !/^[0-9a-f-]{36}$/iu.test(parsed.i)
    ) {
      throw new Error("invalid");
    }
    return { rowNumber: Number(parsed.r), id: parsed.i };
  } catch {
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The import row cursor is invalid.",
    );
  }
}

function previewRows(rows: readonly ImportStagedRow[]) {
  return rows.slice(0, PREVIEW_LIMIT).map((row) => ({
    rowNumber: row.rowNumber,
    normalizedPayload: row.normalizedPayload,
    issues: (Array.isArray(row.validationErrors)
      ? row.validationErrors
      : []
    ).slice(0, ISSUE_LIMIT),
    state: row.state,
  }));
}

export function createImportsService(
  context: ImportServiceContext,
  runtime: ImportServiceRuntime,
) {
  const repository = createImportsRepository(context.database);
  const audit = createAuditService(context);
  const fileVisibility = resourceVisibilitySql(context, {
    resourceKind: "file",
    id: files.id,
    sensitivity: files.sensitivity,
  });

  async function requireMapping(id: string): Promise<ImportMappingRow> {
    const row = await repository.getMapping({
      id,
      workspaceId: context.workspaceId,
    });
    if (!row) return notFound();
    return row;
  }

  async function requireImport(id: string): Promise<ImportRow> {
    const row = await repository.getImport({
      id,
      workspaceId: context.workspaceId,
    });
    if (!row) return notFound();
    return row;
  }

  async function validateFixedReferences(
    mapping: ImportMapping,
    database = context.database,
  ): Promise<void> {
    if (mapping.recordKind === "PERSON") {
      const definitionIds = [
        ...new Set(mapping.facts.map((fact) => fact.definitionId)),
      ];
      if (!definitionIds.length) return;
      const rows = await database
        .select({ id: factDefinitions.id })
        .from(factDefinitions)
        .where(
          and(
            eq(factDefinitions.workspaceId, context.workspaceId),
            inArray(factDefinitions.id, definitionIds),
            isNull(factDefinitions.deletedAt),
            eq(factDefinitions.state, "active"),
          ),
        )
        .for("share");
      if (rows.length !== definitionIds.length) return notFound();
      return;
    }
    const [row] = await database
      .select({ id: relationshipTypes.id })
      .from(relationshipTypes)
      .where(
        and(
          eq(relationshipTypes.workspaceId, context.workspaceId),
          eq(relationshipTypes.id, mapping.relationship.typeId),
          isNull(relationshipTypes.deletedAt),
          eq(relationshipTypes.state, "active"),
        ),
      )
      .limit(1)
      .for("share");
    if (!row) return notFound();
    const personImportIds = [
      mapping.relationship.sourcePerson,
      mapping.relationship.targetPerson,
    ].flatMap((endpoint) =>
      endpoint.kind === "EXTERNAL_KEY" ? [endpoint.personImportId] : [],
    );
    const uniqueImportIds = [...new Set(personImportIds)];
    if (!uniqueImportIds.length) return;
    const referencedImports = await database
      .select({
        id: importsTable.id,
        mapping: importsTable.mapping,
        state: importsTable.state,
      })
      .from(importsTable)
      .where(
        and(
          eq(importsTable.workspaceId, context.workspaceId),
          inArray(importsTable.id, uniqueImportIds),
          inArray(importsTable.state, ["completed", "completed_with_errors"]),
        ),
      )
      .for("share");
    const valid = referencedImports.filter((referencedImport) => {
      try {
        const stored = mappingEnvelope(referencedImport.mapping);
        return (
          stored.mode === "COMMIT" && stored.definition.recordKind === "PERSON"
        );
      } catch {
        return false;
      }
    });
    if (valid.length !== uniqueImportIds.length) return notFound();
  }

  async function replay(importRow: ImportRow) {
    const rows = await repository.listRows({
      importId: importRow.id,
      stagingGeneration: importRow.stagingGeneration,
      workspaceId: context.workspaceId,
      limit: PREVIEW_LIMIT,
    });
    return {
      import: importRow,
      preview: previewRows(rows),
      issues: [] as const,
    };
  }

  async function queueImport(input: {
    importId: string;
    expectedVersion: number;
    idempotencyKey: string;
    retry: boolean;
  }) {
    requireSession(context);
    requirePermission(context, "import:run");
    const current = await requireImport(input.importId);
    let stored: StoredImportMapping;
    try {
      stored = mappingEnvelope(current.mapping);
    } catch {
      throw createGraphQLError(
        "PRECONDITION_FAILED",
        "The stored import mapping must be repaired before retrying.",
      );
    }
    if (stored.definition.recordKind === "PERSON") {
      requirePermission(context, "person:create");
      if (stored.definition.facts.length)
        requirePermission(context, "fact:create");
    } else {
      requirePermission(context, "relationship:create");
      requirePermission(context, "person:read");
    }
    const rawKey = normalizedIdempotency(input.idempotencyKey);
    const keyHash = hmac(
      runtime.encryptionKey,
      "import-job-idempotency",
      canonicalJson({
        actorId: context.actor.id,
        key: rawKey,
        workspaceId: context.workspaceId,
      }),
    );
    return withResearchWriteTransaction(context, async (database) => {
      await database.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`humans:imports:${context.workspaceId}`}, 0))`,
      );
      const scoped = createImportsRepository(database);
      const scopedJobs = createJobsService({
        database,
        encryptionKey: runtime.encryptionKey,
      });
      const replayJob = await scopedJobs.repository.lockByIdempotency({
        idempotencyKey: keyHash,
        kind: "import_execute",
        workspaceId: context.workspaceId,
      });
      const priorJob =
        !replayJob && current.executionJobId
          ? await scopedJobs.repository.lockById({
              id: current.executionJobId,
              workspaceId: context.workspaceId,
            })
          : null;
      const locked = await scoped.lockImport({
        id: current.id,
        workspaceId: context.workspaceId,
      });
      if (!locked) return notFound();
      const allowed = input.retry
        ? ["failed", "dead_letter", "completed_with_errors"]
        : ["preview_ready"];
      let lockedStored: StoredImportMapping;
      try {
        lockedStored = mappingEnvelope(locked.mapping);
      } catch {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The stored import mapping must be repaired before retrying.",
        );
      }
      const [[lockedFile], [lockedMapping]] = await Promise.all([
        database
          .select({
            byteSize: files.byteSize,
            checksum: files.checksum,
            id: files.id,
            quarantineState: files.quarantineState,
            scanState: files.scanState,
          })
          .from(files)
          .where(
            and(
              eq(files.workspaceId, context.workspaceId),
              eq(files.id, locked.fileId),
              isNull(files.deletedAt),
            ),
          )
          .limit(1)
          .for("share"),
        database
          .select()
          .from(importMappings)
          .where(
            and(
              eq(importMappings.workspaceId, context.workspaceId),
              eq(importMappings.id, lockedStored.mappingId),
              isNull(importMappings.deletedAt),
            ),
          )
          .limit(1)
          .for("share"),
      ]);
      let currentMappingHash = "";
      try {
        currentMappingHash = createHash("sha256")
          .update(
            canonicalJson(
              parseImportMappingEnvelope(lockedMapping?.columnMapping),
            ),
          )
          .digest("hex");
      } catch {
        // The same public precondition below covers invalid stored snapshots.
      }
      if (
        !lockedFile ||
        !lockedMapping ||
        lockedStored.fileChecksum === undefined ||
        lockedStored.fileSize === undefined ||
        lockedFile.checksum !== lockedStored.fileChecksum ||
        lockedFile.byteSize !== lockedStored.fileSize ||
        lockedFile.quarantineState !== "available" ||
        !["clean", "not_required"].includes(lockedFile.scanState) ||
        lockedMapping.version !== lockedStored.mappingVersion ||
        currentMappingHash !== lockedStored.mappingHash
      ) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          publicErrorMessage("PRECONDITION_FAILED"),
        );
      }
      if (lockedStored.definition.recordKind === "PERSON") {
        requirePermission(context, "person:create");
        if (lockedStored.definition.facts.length)
          requirePermission(context, "fact:create");
      } else {
        requirePermission(context, "relationship:create");
        requirePermission(context, "person:read");
      }
      await validateFixedReferences(lockedStored.definition, database);
      const requestHash = `sha256:${hmac(
        runtime.encryptionKey,
        "import-job-request",
        canonicalJson({
          actorId: context.actor.id,
          expectedVersion: input.expectedVersion,
          fileChecksum: lockedFile.checksum,
          fileId: lockedFile.id,
          fileSize: lockedFile.byteSize,
          importId: locked.id,
          mappingHash: lockedStored.mappingHash,
          mappingId: lockedStored.mappingId,
          mappingVersion: lockedStored.mappingVersion,
          mode: lockedStored.mode,
          operation: input.retry ? "retry" : "start",
          workspaceId: context.workspaceId,
        }),
      )}`;
      if (replayJob) {
        let payload;
        try {
          payload = scopedJobs.decode(replayJob);
        } catch {
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        }
        if (
          locked.executionJobId !== replayJob.id ||
          !replayJob.requestHash ||
          !equalJobHashes(replayJob.requestHash, requestHash) ||
          payload.kind !== "import_execute" ||
          payload.importId !== locked.id
        ) {
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        }
        return { import: locked, job: replayJob, issues: [] as const };
      }
      if (
        locked.version !== input.expectedVersion ||
        !allowed.includes(locked.state) ||
        locked.executionJobId !== current.executionJobId ||
        (input.retry &&
          (!priorJob ||
            (priorJob.state !== "completed" &&
              priorJob.state !== "dead_letter")))
      ) {
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      const actorCount = await scoped.countActive({
        actorId: context.actor.id,
        workspaceId: context.workspaceId,
      });
      const workspaceCount = await scoped.countActive({
        workspaceId: context.workspaceId,
      });
      if (
        actorCount >= ACTIVE_IMPORTS_ACTOR ||
        workspaceCount >= ACTIVE_IMPORTS_WORKSPACE
      ) {
        throw createGraphQLError(
          "RATE_LIMITED",
          publicErrorMessage("RATE_LIMITED"),
        );
      }
      const now = new Date();
      let acceptedRows = locked.acceptedRows;
      let rejectedRows = locked.rejectedRows;
      if (input.retry) {
        const reset = await scoped.resetExecutionRowsForRetry({
          actorId: context.actor.id,
          importId: locked.id,
          includeProcessing:
            locked.state === "failed" || locked.state === "dead_letter",
          now,
          workspaceId: context.workspaceId,
        });
        const physicalCount = [...reset.byState.values()].reduce(
          (sum, count) => sum + count,
          0,
        );
        if (
          physicalCount !== locked.totalRows ||
          (locked.state === "completed_with_errors" && reset.resetCount === 0)
        ) {
          throw createGraphQLError(
            "PRECONDITION_FAILED",
            publicErrorMessage("PRECONDITION_FAILED"),
          );
        }
        acceptedRows = reset.byState.get("succeeded") ?? 0;
        rejectedRows = reset.byState.get("rejected") ?? 0;
      }
      const job = await scopedJobs.enqueue({
        workspaceId: context.workspaceId,
        idempotencyKey: keyHash,
        payload: { kind: "import_execute", importId: locked.id },
        requestHash,
        createdBy: context.actor.id,
      });
      const transitioned = await scoped.transitionImport({
        acceptedRows,
        id: locked.id,
        workspaceId: context.workspaceId,
        expectedVersion: locked.version,
        from: allowed,
        state: "queued",
        now,
        actorId: context.actor.id,
        completedAt: null,
        executionJobId: job.id,
        rejectedRows,
        startedAt: null,
      });
      if (!transitioned)
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      await audit.write(database, {
        action: input.retry ? "import.retry_queued" : "import.queued",
        changedFields: [
          "acceptedRows",
          "completedAt",
          "executionJobId",
          "rejectedRows",
          "startedAt",
          "state",
          "version",
        ],
        resourceId: locked.id,
        resourceKind: "import",
        metadata: { jobId: job.id, version: transitioned.version },
      });
      return { import: transitioned, job, issues: [] as const };
    });
  }

  return {
    async saveMapping(input: {
      id?: string | null;
      expectedVersion?: number | null;
      name: string;
      format: ImportFormat;
      definition: unknown;
    }) {
      requireSession(context);
      requirePermission(context, input.id ? "import:update" : "import:create");
      const name =
        typeof input.name === "string"
          ? input.name.normalize("NFKC").trim()
          : "";
      if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The mapping name is invalid.",
        );
      }
      if (input.format !== "CSV" && input.format !== "JSON") {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The mapping format is invalid.",
        );
      }
      let definition: ImportMapping;
      try {
        definition = parseImportMappingEnvelope(input.definition);
      } catch {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The import mapping is invalid.",
        );
      }
      await validateFixedReferences(definition);
      const now = new Date();
      return withResearchWriteTransaction(context, async (database) => {
        const scoped = createImportsRepository(database);
        const row = input.id
          ? await scoped.updateMapping({
              id: input.id,
              workspaceId: context.workspaceId,
              expectedVersion: input.expectedVersion ?? 0,
              name,
              format: input.format,
              definition,
              validationConfig: { mappingVersion: 1 },
              now,
              actorId: context.actor.id,
            })
          : await scoped.createMapping({
              id: newId(),
              workspaceId: context.workspaceId,
              name,
              format: input.format,
              columnMapping: definition,
              validationConfig: { mappingVersion: 1 },
              createdAt: now,
              createdBy: context.actor.id,
              updatedAt: now,
              updatedBy: context.actor.id,
            });
        if (!row)
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        await audit.write(database, {
          action: input.id
            ? "import_mapping.updated"
            : "import_mapping.created",
          changedFields: ["name", "format", "columnMapping", "version"],
          resourceId: row.id,
          resourceKind: "import_mapping",
          metadata: { format: row.format, version: row.version },
        });
        return { mapping: row, issues: [] as const };
      });
    },

    async prepareImport(input: {
      fileId: string;
      mappingId: string;
      idempotencyKey: string;
      mode?: "COMMIT" | "DRY_RUN" | null;
    }) {
      requireSession(context);
      requirePermission(context, "import:create");
      const store = runtime.objectStore;
      if (!store) {
        throw createGraphQLError(
          "PROVIDER_UNAVAILABLE",
          publicErrorMessage("PROVIDER_UNAVAILABLE"),
        );
      }
      await context.operationLimiter.consume({
        cost: 1,
        operationClass: "import.prepare.actor",
        policy: {
          capacity: 5,
          refillAmount: 5,
          refillIntervalMs: 60 * 60_000,
          ttlMs: 60 * 60_000,
        },
      });
      await context.operationLimiter.consume({
        cost: 1,
        operationClass: "import.prepare.workspace",
        scope: "workspace",
        policy: {
          capacity: 20,
          refillAmount: 20,
          refillIntervalMs: 60 * 60_000,
          ttlMs: 60 * 60_000,
        },
      });
      const [file] = await context.database
        .select({ file: files, purpose: uploadSessions.intendedPurpose })
        .from(files)
        .innerJoin(
          uploadSessions,
          and(
            eq(uploadSessions.workspaceId, files.workspaceId),
            eq(uploadSessions.fileId, files.id),
            eq(uploadSessions.state, "completed"),
          ),
        )
        .where(
          and(
            eq(files.workspaceId, context.workspaceId),
            eq(files.id, input.fileId),
            isNull(files.deletedAt),
            fileVisibility,
          ),
        )
        .limit(1);
      if (!file) return notFound();
      if (
        file.file.quarantineState !== "available" ||
        !["clean", "not_required"].includes(file.file.scanState) ||
        (file.purpose !== "CSV_IMPORT" && file.purpose !== "JSON_IMPORT")
      ) {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "The file is not eligible for import.",
        );
      }
      const format: ImportFormat =
        file.purpose === "CSV_IMPORT" ? "CSV" : "JSON";
      const mappingRow = await requireMapping(input.mappingId);
      if (mappingRow.format !== format) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The mapping format does not match the file.",
        );
      }
      const structural = parseImportMappingEnvelope(mappingRow.columnMapping);
      await validateFixedReferences(structural);
      const mode = input.mode ?? "COMMIT";
      const rawKey = normalizedIdempotency(input.idempotencyKey);
      const definitionCanonical = canonicalJson(structural);
      const mappingHash = createHash("sha256")
        .update(definitionCanonical)
        .digest("hex");
      const requestHash = hmac(
        runtime.encryptionKey,
        "import-prepare-request",
        canonicalJson({
          actorId: context.actor.id,
          fileChecksum: file.file.checksum,
          fileSize: file.file.byteSize,
          mappingHash,
          mappingId: mappingRow.id,
          mappingVersion: mappingRow.version,
          mode,
          workspaceId: context.workspaceId,
        }),
      );
      const idempotencyKey = hmac(
        runtime.encryptionKey,
        "import-prepare-key",
        canonicalJson({
          actorId: context.actor.id,
          key: rawKey,
          workspaceId: context.workspaceId,
        }),
      );
      const envelope: StoredImportMapping = {
        definition: structural,
        fileChecksum: file.file.checksum,
        fileSize: file.file.byteSize,
        mappingHash,
        mappingId: mappingRow.id,
        mappingVersion: mappingRow.version,
        mode,
        requestHash,
      };
      const stagingOwner = newId();
      const stagingId = newId();
      const claimOnce = () =>
        withResearchWriteTransaction(context, async (database) => {
          const claim = await createImportsRepository(database).claimPrepare({
            actorId: context.actor.id,
            envelope,
            fileId: file.file.id,
            format,
            id: stagingId,
            idempotencyKey,
            leaseMs: PREPARE_LEASE_MS,
            owner: stagingOwner,
            requestHash,
            workspaceId: context.workspaceId,
          });
          if (claim.created) {
            await audit.write(database, {
              action: "import.staging_started",
              changedFields: ["fileId", "format", "state", "mapping"],
              resourceId: claim.import.id,
              resourceKind: "import",
              metadata: { format, mappingId: mappingRow.id, mode },
            });
          }
          return claim;
        });
      let claim = await claimOnce();
      while (claim.status === "wait") {
        await new Promise((resolve) => setTimeout(resolve, PREPARE_WAIT_MS));
        claim = await claimOnce();
      }
      if (claim.status === "replay") return replay(claim.import);
      if (claim.status !== "claimed") {
        throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
      }
      const stagedImport = claim.import;
      const stagingGeneration = claim.generation;
      const object = await store
        .openRead(
          { workspaceId: context.workspaceId, key: file.file.storageKey },
          { maxBytes: file.file.byteSize },
        )
        .catch(() => {
          throw createGraphQLError(
            "PROVIDER_UNAVAILABLE",
            publicErrorMessage("PROVIDER_UNAVAILABLE"),
          );
        });
      if (!object) {
        throw createGraphQLError(
          "PROVIDER_UNAVAILABLE",
          publicErrorMessage("PROVIDER_UNAVAILABLE"),
        );
      }
      const seenRowKeys = new Set<string>();
      let batch: Array<Parameters<typeof repository.insertRows>[0][number]> =
        [];
      let rejectedRows = 0;
      let remainingIssueBudget = ISSUE_LIMIT;
      const flush = async () => {
        if (!batch.length) return;
        const values = batch;
        batch = [];
        const inserted = await createImportsRepository(
          context.database,
        ).insertPrepareRows({
          generation: stagingGeneration,
          importId: stagedImport.id,
          leaseMs: PREPARE_LEASE_MS,
          owner: stagingOwner,
          values,
          workspaceId: context.workspaceId,
        });
        if (!inserted) {
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        }
      };
      let parsed;
      try {
        parsed = await parseImportStream({
          format,
          stream: object.body,
          onRow: async (row) => {
            let normalizedPayload: unknown = {};
            let validationErrors: Array<{ code: string; message: string }> =
              row.warnings.map((code) => ({
                code,
                message: "A value may be interpreted as a spreadsheet formula.",
              }));
            let state = "pending";
            try {
              const projected = projectImportRow(structural, row.values);
              if (seenRowKeys.has(projected.rowKey)) {
                throw new TypeError("The import row key is duplicated");
              }
              seenRowKeys.add(projected.rowKey);
              normalizedPayload = projected;
            } catch {
              state = "rejected";
              rejectedRows += 1;
              validationErrors.push({
                code: "ROW_VALIDATION_FAILED",
                message: "The row does not satisfy the selected mapping.",
              });
            }
            validationErrors = validationErrors.slice(0, remainingIssueBudget);
            remainingIssueBudget -= validationErrors.length;
            const sourceHash = hmac(
              runtime.encryptionKey,
              "import-row-source",
              canonicalJson({ rowNumber: row.rowNumber, values: row.values }),
            );
            batch.push({
              id: newId(),
              workspaceId: context.workspaceId,
              importId: stagedImport.id,
              stagingGeneration,
              rowNumber: row.rowNumber,
              sourceHash,
              normalizedPayload,
              validationErrors,
              state,
              createdAt: new Date(),
              createdBy: context.actor.id,
              updatedAt: new Date(),
              updatedBy: context.actor.id,
            });
            if (batch.length >= STAGE_BATCH_SIZE) await flush();
          },
        });
        await flush();
        parseImportMapping(structural, parsed.columns);
      } catch (error) {
        const failed = await repository.failPrepare({
          actorId: context.actor.id,
          generation: stagingGeneration,
          importId: stagedImport.id,
          owner: stagingOwner,
          workspaceId: context.workspaceId,
        });
        if (error && typeof error === "object" && "extensions" in error)
          throw error;
        if (!failed) {
          throw createGraphQLError("CONFLICT", publicErrorMessage("CONFLICT"));
        }
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The import could not be prepared.",
        );
      }
      const prepared = await withResearchWriteTransaction(
        context,
        async (database) => {
          const scoped = createImportsRepository(database);
          const row = await scoped.finishPrepare({
            actorId: context.actor.id,
            generation: stagingGeneration,
            importId: stagedImport.id,
            workspaceId: context.workspaceId,
            mapping: envelope,
            owner: stagingOwner,
            rejectedRows,
            totalRows: parsed.totalRows,
          });
          if (!row)
            throw createGraphQLError(
              "CONFLICT",
              publicErrorMessage("CONFLICT"),
            );
          await audit.write(database, {
            action: "import.preview_ready",
            changedFields: ["state", "totalRows", "rejectedRows", "version"],
            resourceId: row.id,
            resourceKind: "import",
            metadata: {
              rejectedRows,
              totalRows: parsed.totalRows,
              version: row.version,
            },
          });
          return row;
        },
      );
      return replay(prepared);
    },

    startImport(input: {
      importId: string;
      expectedVersion: number;
      idempotencyKey: string;
    }) {
      return queueImport({ ...input, retry: false });
    },

    retryImport(input: {
      importId: string;
      expectedVersion: number;
      idempotencyKey: string;
    }) {
      return queueImport({ ...input, retry: true });
    },

    async get(id: string) {
      requirePermission(context, "import:read");
      return requireImport(id);
    },

    async getByIds(ids: readonly string[]) {
      requirePermission(context, "import:read");
      const rows = await repository.getImportsByIds({
        ids,
        workspaceId: context.workspaceId,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },

    async getMappingsByIds(ids: readonly string[]) {
      requirePermission(context, "import:read");
      const rows = await repository.getMappingsByIds({
        ids,
        workspaceId: context.workspaceId,
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      return ids.map((id) => byId.get(id) ?? null);
    },

    async listRows(input: {
      importId: string;
      first?: number | null;
      after?: string | null;
    }) {
      requirePermission(context, "import:read");
      const first = input.first ?? 25;
      if (!Number.isSafeInteger(first) || first < 1 || first > 100) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The page size is invalid.",
        );
      }
      const importRow = await requireImport(input.importId);
      if (importRow.state === "staging") {
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "Import diagnostics are not available while staging is active.",
        );
      }
      const rows = await repository.listRows({
        importId: importRow.id,
        stagingGeneration: importRow.stagingGeneration,
        workspaceId: context.workspaceId,
        limit: first + 1,
        cursor: parseRowCursor(input.after),
      });
      const nodes = rows.slice(0, first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: nodes.length ? rowCursor(nodes.at(-1)!) : null,
        },
      };
    },

    async list(input: {
      first?: number | null;
      after?: string | null;
      state?: string | null;
    }) {
      requirePermission(context, "import:read");
      const first = input.first ?? 25;
      if (!Number.isInteger(first) || first < 1 || first > 100) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The page size is invalid.",
        );
      }
      const state = input.state?.toLowerCase() ?? null;
      const rows = await repository.listImports({
        workspaceId: context.workspaceId,
        limit: first + 1,
        cursor: parsePageCursor(input.after),
        state,
      });
      const nodes = rows.slice(0, first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: nodes.length ? pageCursor(nodes.at(-1)!) : null,
        },
      };
    },

    async listMappings(input: {
      first?: number | null;
      after?: string | null;
    }) {
      requirePermission(context, "import:read");
      const first = input.first ?? 25;
      if (!Number.isInteger(first) || first < 1 || first > 100) {
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The page size is invalid.",
        );
      }
      const rows = await repository.listMappings({
        workspaceId: context.workspaceId,
        limit: first + 1,
        cursor: parsePageCursor(input.after),
      });
      const nodes = rows.slice(0, first);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: nodes.length ? pageCursor(nodes.at(-1)!) : null,
        },
      };
    },
  };
}

export type ImportsService = ReturnType<typeof createImportsService>;
