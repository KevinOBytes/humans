import { z } from "zod";

import type { Database } from "@/modules/auth/bootstrap-admin";
import {
  completeDurableImportRowDryRun,
  rejectDurableImportRow,
  runDurableImportRowResearchTransaction,
} from "@/modules/audit/transactions";
import { createFactsService } from "@/modules/facts/service";
import {
  JOB_LEASE_MS,
  JobExecutionError,
  JobSliceDeferred,
} from "@/modules/jobs/types";
import { createPeopleService } from "@/modules/people/service";
import { createImportIdentityService } from "@/modules/people/import-identity-service";
import { createRelationshipsService } from "@/modules/relationships/service";
import type { SearchIndexMaintenance } from "@/modules/search/index-maintenance";

import { createImportsRepository } from "./repository";
import { importFactValue } from "./fact-value";
import type { ImportValue } from "./types";

const IMPORT_ROW_BATCH_SIZE = 25;

const sensitivity = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
const personRow = z
  .object({
    kind: z.literal("PERSON"),
    rowKey: z.string().min(1).max(20_000),
    person: z
      .object({
        displayName: z.string().min(1).max(300),
        sortName: z.string().min(1).max(300).optional(),
        preferredName: z.string().min(1).max(300).optional(),
        biography: z.string().max(20_000).optional(),
      })
      .strict(),
    primaryNameKind: z.enum([
      "legal",
      "preferred",
      "birth",
      "married",
      "former",
      "alias",
      "transliteration",
      "other",
    ]),
    facts: z
      .array(
        z
          .object({
            definitionId: z.uuid(),
            value: z.custom<ImportValue>((value) => value !== undefined),
          })
          .strict(),
      )
      .max(100),
    defaults: z
      .object({
        sensitivity: sensitivity.optional(),
        status: z.enum(["active", "deceased", "missing", "unknown"]).optional(),
      })
      .strict(),
  })
  .strict();

const relationshipRow = z
  .object({
    kind: z.literal("RELATIONSHIP"),
    rowKey: z.string().min(1).max(20_000),
    relationship: z
      .object({
        typeId: z.uuid(),
        sourcePerson: z.discriminatedUnion("kind", [
          z
            .object({ kind: z.literal("PERSON_ID"), personId: z.uuid() })
            .strict(),
          z
            .object({
              kind: z.literal("EXTERNAL_KEY"),
              personImportId: z.uuid(),
              externalId: z.string().min(1).max(512),
            })
            .strict(),
        ]),
        targetPerson: z.discriminatedUnion("kind", [
          z
            .object({ kind: z.literal("PERSON_ID"), personId: z.uuid() })
            .strict(),
          z
            .object({
              kind: z.literal("EXTERNAL_KEY"),
              personImportId: z.uuid(),
              externalId: z.string().min(1).max(512),
            })
            .strict(),
        ]),
        labelOverride: z.string().min(1).max(300).optional(),
      })
      .strict(),
    defaults: z
      .object({
        sensitivity: sensitivity.optional(),
        state: z
          .enum(["asserted", "disputed", "disproven", "superseded"])
          .optional(),
      })
      .strict(),
  })
  .strict();

const executableRow = z.discriminatedUnion("kind", [
  personRow,
  relationshipRow,
]);

export type ImportExecuteJobService = {
  executeImportJob(input: {
    claimGeneration: number;
    importId: string;
    jobId: string;
    leaseOwner: string;
    renewLease(): Promise<boolean>;
    signal: AbortSignal;
    workspaceId: string;
  }): Promise<{ resultReferences?: readonly string[] } | void>;
};

function leaseLost(): never {
  throw new JobExecutionError("lease_lost", "retryable");
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new JobExecutionError("worker_draining", "retryable");
}

function expectedDomainFailure(error: unknown): boolean {
  const code =
    error && typeof error === "object"
      ? (error as { extensions?: { code?: unknown } }).extensions?.code
      : null;
  return (
    code === "CONFLICT" ||
    code === "NOT_FOUND" ||
    code === "PRECONDITION_FAILED" ||
    code === "VALIDATION_FAILED"
  );
}

export function createImportExecuteService(input: {
  database: Database;
  encryptionKey: string;
  searchIndexMaintenance: SearchIndexMaintenance;
  now?: () => Date;
}): ImportExecuteJobService {
  const repository = createImportsRepository(input.database);
  const now = input.now ?? (() => new Date());

  return {
    async executeImportJob(job) {
      throwIfAborted(job.signal);
      if (!(await job.renewLease())) return leaseLost();
      throwIfAborted(job.signal);
      const timestamp = now();
      const slice = await repository.claimExecutionSlice({
        claimGeneration: job.claimGeneration,
        importId: job.importId,
        jobId: job.jobId,
        leaseOwner: job.leaseOwner,
        limit: IMPORT_ROW_BATCH_SIZE,
        now: timestamp,
        staleBefore: new Date(timestamp.getTime() - JOB_LEASE_MS),
        workspaceId: job.workspaceId,
      });
      if (slice.status === "lease_lost") return leaseLost();
      if (slice.status === "binding_not_found") {
        throw new JobExecutionError("import_binding_invalid", "permanent");
      }
      if (slice.status === "state_conflict") {
        throw new JobExecutionError("import_state_conflict", "retryable");
      }
      if (slice.status === "invalid_state") {
        throw new JobExecutionError("invalid_import_state", "permanent");
      }
      if (slice.status === "terminal") {
        return { resultReferences: [slice.import.id] };
      }

      for (const claimedRow of slice.rows) {
        throwIfAborted(job.signal);
        if (!(await job.renewLease())) return leaseLost();
        throwIfAborted(job.signal);
        await runDurableImportRowResearchTransaction(
          input.database,
          {
            encryptionKey: input.encryptionKey,
            claimGeneration: job.claimGeneration,
            importRowId: claimedRow.id,
            jobId: job.jobId,
            leaseOwner: job.leaseOwner,
            searchIndexMaintenance: input.searchIndexMaintenance,
            workspaceId: job.workspaceId,
          },
          async ({ context, mode, row }) => {
            const parsed = executableRow.safeParse(row.normalizedPayload);
            if (!parsed.success) {
              return rejectDurableImportRow({ code: "INVALID_IMPORT_ROW" });
            }
            if (parsed.data.kind === "PERSON") {
              let personOutcome;
              try {
                personOutcome = await createPeopleService(context).create({
                  ...parsed.data.person,
                  sensitivity: parsed.data.defaults.sensitivity,
                  status: parsed.data.defaults.status,
                });
              } catch (error) {
                if (!expectedDomainFailure(error)) throw error;
                return rejectDurableImportRow({
                  code: "PERSON_VALIDATION_FAILED",
                });
              }
              if (!personOutcome.resource || personOutcome.code) {
                return rejectDurableImportRow({
                  code: "PERSON_VALIDATION_FAILED",
                });
              }
              const person = personOutcome.resource;
              let identity;
              try {
                identity = await createImportIdentityService(
                  context,
                ).attachPersonIdentity({ personId: person.id });
              } catch (error) {
                if (!expectedDomainFailure(error)) throw error;
                return rejectDurableImportRow({
                  code: "PERSON_VALIDATION_FAILED",
                });
              }
              const references = [
                person.id,
                identity.personName.id,
                identity.externalRecord.id,
              ];
              for (const factInput of parsed.data.facts) {
                let factOutcome;
                try {
                  const factsService = createFactsService(context);
                  const definition = await factsService.getDefinition(
                    factInput.definitionId,
                  );
                  if (!definition || definition.state !== "active") {
                    return rejectDurableImportRow({
                      code: "FACT_VALIDATION_FAILED",
                    });
                  }
                  factOutcome = await factsService.create({
                    personId: person.id,
                    definitionId: factInput.definitionId,
                    value: importFactValue(
                      definition.allowedValueType,
                      factInput.value,
                    ),
                    sensitivity: parsed.data.defaults.sensitivity,
                  });
                } catch (error) {
                  if (!expectedDomainFailure(error)) throw error;
                  return rejectDurableImportRow({
                    code: "FACT_VALIDATION_FAILED",
                  });
                }
                if (!factOutcome.resource || factOutcome.code) {
                  return rejectDurableImportRow({
                    code: "FACT_VALIDATION_FAILED",
                  });
                }
                if (references.length < 32) {
                  references.push(factOutcome.resource.id);
                }
              }
              if (mode === "DRY_RUN") {
                return completeDurableImportRowDryRun();
              }
              return { resultReferences: references, value: person.id };
            }
            const identity = createImportIdentityService(context);
            const [sourcePersonId, targetPersonId] = await Promise.all([
              identity.resolveRelationshipPerson({ endpoint: "source" }),
              identity.resolveRelationshipPerson({ endpoint: "target" }),
            ]);
            if (!sourcePersonId || !targetPersonId) {
              return rejectDurableImportRow({
                code: "PERSON_ENDPOINT_NOT_FOUND",
              });
            }
            let relationshipOutcome;
            try {
              relationshipOutcome = await createRelationshipsService(
                context,
              ).create({
                relationshipTypeId: parsed.data.relationship.typeId,
                sourcePersonId,
                targetPersonId,
                labelOverride: parsed.data.relationship.labelOverride,
                sensitivity: parsed.data.defaults.sensitivity,
                state: parsed.data.defaults.state,
              });
            } catch (error) {
              if (!expectedDomainFailure(error)) throw error;
              return rejectDurableImportRow({
                code: "RELATIONSHIP_VALIDATION_FAILED",
              });
            }
            if (!relationshipOutcome.resource || relationshipOutcome.code) {
              return rejectDurableImportRow({
                code: "RELATIONSHIP_VALIDATION_FAILED",
              });
            }
            if (mode === "DRY_RUN") {
              return completeDurableImportRowDryRun();
            }
            return {
              resultReferences: [relationshipOutcome.resource.id],
              value: relationshipOutcome.resource.id,
            };
          },
        );
      }

      throwIfAborted(job.signal);
      if (!(await job.renewLease())) return leaseLost();
      throwIfAborted(job.signal);
      const refreshed = await repository.refreshExecutionTotals({
        claimGeneration: job.claimGeneration,
        id: slice.import.id,
        jobId: job.jobId,
        leaseOwner: job.leaseOwner,
        workspaceId: job.workspaceId,
        now: now(),
      });
      if (refreshed.status === "lease_lost") return leaseLost();
      if (refreshed.status === "binding_not_found") {
        throw new JobExecutionError("import_binding_invalid", "permanent");
      }
      if (refreshed.status === "invariant_error") {
        throw new JobExecutionError("import_row_invariant", "permanent");
      }
      if (refreshed.status === "invalid_state") {
        throw new JobExecutionError("invalid_import_state", "permanent");
      }
      if (refreshed.status === "state_conflict") {
        throw new JobExecutionError("import_state_conflict", "retryable");
      }
      if (
        refreshed.import.state === "completed" ||
        refreshed.import.state === "completed_with_errors"
      ) {
        return { resultReferences: [refreshed.import.id] };
      }
      throw new JobSliceDeferred();
    },
  };
}
