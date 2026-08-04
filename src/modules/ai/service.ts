import { and, eq, inArray, isNull } from "drizzle-orm";

import { evidenceItems } from "@/db/schema/evidence";
import { apiKeys } from "@/db/schema/auth";
import { people } from "@/db/schema/people";
import { createGraphQLError } from "@/graphql/errors";
import {
  resourceVisibilitySql,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  runResearchTransaction,
} from "@/modules/audit/transactions";
import type { AiProvider } from "./types";
import { parseApiKeyPermissionKeys } from "@/modules/auth/permissions";
import {
  createAiRepository,
  type AiCitation,
  type AiRepositoryRuntime,
  type AiRun,
  type AiScope,
} from "./repository";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FINGERPRINT = /^[0-9a-f]{64}$/u;
const MAX_QUESTION_BYTES = 8_000;
const MAX_SCOPE_IDS_PER_KIND = 100;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

export type StartAiAnalysisInput = Readonly<{
  idempotencyKey: string;
  question: string;
  scope?: Readonly<{
    evidenceIds?: readonly string[];
    personIds?: readonly string[];
  }>;
}>;

export type AiAnalysisRuntime = AiRepositoryRuntime &
  Readonly<{
    provider: Pick<AiProvider, "baseUrlFingerprint" | "disclosure">;
  }>;

function validationError(): never {
  throw createGraphQLError(
    "VALIDATION_FAILED",
    "The AI analysis request is invalid.",
  );
}

function normalizeIds(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_SCOPE_IDS_PER_KIND) {
    return validationError();
  }
  const normalized = value.map((id) => {
    if (typeof id !== "string" || !UUID.test(id)) return validationError();
    return id.toLowerCase();
  });
  return Object.freeze([...new Set(normalized)].sort());
}

function normalizeStartInput(input: StartAiAnalysisInput): {
  idempotencyKey: string;
  question: string;
  scope: AiScope;
} {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).some(
      (key) =>
        key !== "idempotencyKey" && key !== "question" && key !== "scope",
    ) ||
    typeof input.question !== "string" ||
    typeof input.idempotencyKey !== "string"
  ) {
    return validationError();
  }
  const question = input.question
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim();
  if (
    Buffer.byteLength(question, "utf8") < 1 ||
    Buffer.byteLength(question, "utf8") > MAX_QUESTION_BYTES
  ) {
    return validationError();
  }
  const scopeValue = input.scope;
  if (
    scopeValue !== undefined &&
    (!scopeValue ||
      typeof scopeValue !== "object" ||
      Array.isArray(scopeValue) ||
      Object.getPrototypeOf(scopeValue) !== Object.prototype ||
      Object.keys(scopeValue).some(
        (key) => key !== "evidenceIds" && key !== "personIds",
      ))
  ) {
    return validationError();
  }
  const scope = Object.freeze({
    evidenceIds: normalizeIds(scopeValue?.evidenceIds),
    personIds: normalizeIds(scopeValue?.personIds),
  });
  return { idempotencyKey: input.idempotencyKey, question, scope };
}

function validateRuntime(runtime: AiAnalysisRuntime): void {
  if (
    !runtime ||
    typeof runtime !== "object" ||
    !runtime.provider ||
    !FINGERPRINT.test(runtime.provider.baseUrlFingerprint) ||
    !["COMPATIBLE", "OLLAMA", "OPENAI"].includes(
      runtime.provider.disclosure.provider,
    ) ||
    typeof runtime.provider.disclosure.model !== "string" ||
    runtime.provider.disclosure.model !==
      runtime.provider.disclosure.model.trim() ||
    Buffer.byteLength(runtime.provider.disclosure.model, "utf8") < 1 ||
    Buffer.byteLength(runtime.provider.disclosure.model, "utf8") > 256
  ) {
    throw new TypeError("Invalid AI analysis runtime");
  }
}

async function requireAuthorizedScope(
  context: ResearchServiceContext,
  scope: AiScope,
): Promise<void> {
  if (scope.personIds.length) {
    const visible = await context.database
      .select({ id: people.id })
      .from(people)
      .where(
        and(
          eq(people.workspaceId, context.workspaceId),
          inArray(people.id, [...scope.personIds]),
          isNull(people.deletedAt),
          resourceVisibilitySql(context, {
            resourceKind: "person",
            id: people.id,
            sensitivity: people.sensitivity,
          }),
        ),
      );
    if (visible.length !== scope.personIds.length) return validationError();
  }
  if (scope.evidenceIds.length) {
    const visible = await context.database
      .select({ id: evidenceItems.id })
      .from(evidenceItems)
      .where(
        and(
          eq(evidenceItems.workspaceId, context.workspaceId),
          inArray(evidenceItems.id, [...scope.evidenceIds]),
          isNull(evidenceItems.deletedAt),
          resourceVisibilitySql(context, {
            resourceKind: "evidence",
            id: evidenceItems.id,
            sensitivity: evidenceItems.sensitivity,
          }),
        ),
      );
    if (visible.length !== scope.evidenceIds.length) return validationError();
  }
}

async function visibleResourceIds(
  context: ResearchServiceContext,
  input: { evidenceIds: readonly string[]; personIds: readonly string[] },
): Promise<{ evidence: ReadonlySet<string>; person: ReadonlySet<string> }> {
  const currentPermissions =
    context.actor.type === "apiKey"
      ? parseApiKeyPermissionKeys(
          (
            await context.database
              .select({ permissions: apiKeys.permissions })
              .from(apiKeys)
              .where(
                and(
                  eq(apiKeys.id, context.actor.id),
                  eq(apiKeys.workspaceId, context.workspaceId),
                  eq(apiKeys.enabled, true),
                ),
              )
              .limit(1)
          )[0]?.permissions,
        )
      : context.permissions;
  const visiblePeople =
    input.personIds.length && currentPermissions.has("person:read")
      ? await context.database
          .select({ id: people.id })
          .from(people)
          .where(
            and(
              eq(people.workspaceId, context.workspaceId),
              inArray(people.id, [...input.personIds]),
              isNull(people.deletedAt),
              resourceVisibilitySql(context, {
                resourceKind: "person",
                id: people.id,
                sensitivity: people.sensitivity,
              }),
            ),
          )
      : [];
  const visibleEvidence =
    input.evidenceIds.length && currentPermissions.has("evidence:read")
      ? await context.database
          .select({ id: evidenceItems.id })
          .from(evidenceItems)
          .where(
            and(
              eq(evidenceItems.workspaceId, context.workspaceId),
              inArray(evidenceItems.id, [...input.evidenceIds]),
              isNull(evidenceItems.deletedAt),
              resourceVisibilitySql(context, {
                resourceKind: "evidence",
                id: evidenceItems.id,
                sensitivity: evidenceItems.sensitivity,
              }),
            ),
          )
      : [];
  return {
    evidence: new Set(visibleEvidence.map((row) => row.id)),
    person: new Set(visiblePeople.map((row) => row.id)),
  };
}

async function publicProjection(
  context: ResearchServiceContext,
  run: AiRun | null,
): Promise<AiRun | null> {
  if (!run) return null;
  const references = [
    ...run.citations.map((citation) => ({
      id: citation.resourceId,
      kind: citation.resourceKind,
    })),
    ...run.toolCalls.flatMap((tool) => tool.resourceReferences),
  ];
  const visible = await visibleResourceIds(context, {
    evidenceIds: [
      ...new Set(
        references
          .filter((reference) => reference.kind === "evidence")
          .map((reference) => reference.id),
      ),
    ],
    personIds: [
      ...new Set(
        references
          .filter((reference) => reference.kind === "person")
          .map((reference) => reference.id),
      ),
    ],
  });
  const allowed = (reference: { id: string; kind: "evidence" | "person" }) =>
    visible[reference.kind].has(reference.id);
  return Object.freeze({
    ...run,
    citations: Object.freeze(
      run.citations.filter((citation) =>
        allowed({ id: citation.resourceId, kind: citation.resourceKind }),
      ),
    ) as readonly AiCitation[],
    toolCalls: Object.freeze(
      run.toolCalls.map((tool) =>
        Object.freeze({
          ...tool,
          resourceReferences: Object.freeze(
            tool.resourceReferences.filter(allowed),
          ),
        }),
      ),
    ),
  });
}

function validateRunId(id: string): string {
  if (typeof id !== "string" || !UUID.test(id)) return validationError();
  return id.toLowerCase();
}

export function createAiAnalysisService(
  context: ResearchServiceContext,
  runtime: AiAnalysisRuntime,
) {
  validateRuntime(runtime);
  const repositoryRuntime: AiRepositoryRuntime = {
    encryptionKey: runtime.encryptionKey,
    hmacKey: runtime.hmacKey,
  };

  async function readOwnedAiRun(
    id: string,
    requiredPermissions: readonly string[],
  ): Promise<AiRun | null> {
    const runId = validateRunId(id);
    return runResearchTransaction(
      context,
      { requiredPermissions },
      async (scopedContext) => {
        const run = await createAiRepository(
          scopedContext.database,
          repositoryRuntime,
        ).readOwnedRun({
          principalId: scopedContext.actor.principalId,
          runId,
          workspaceId: scopedContext.workspaceId,
        });
        return publicProjection(scopedContext, run);
      },
    );
  }

  async function readAiRun(id: string): Promise<AiRun | null> {
    return readOwnedAiRun(id, ["analysis:read"]);
  }

  return {
    async startAiAnalysis(input: StartAiAnalysisInput): Promise<AiRun> {
      const normalized = normalizeStartInput(input);
      const requiredPermissions = [
        "analysis:create",
        "analysis:run",
        ...(normalized.scope.personIds.length ? ["person:read"] : []),
        ...(normalized.scope.evidenceIds.length ? ["evidence:read"] : []),
      ];
      const idempotency = derivePrincipalResearchIdempotency(context, {
        expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
        idempotencyKey: normalized.idempotencyKey,
        operation: "ai.analysis.start",
        requestMaterial: {
          question: normalized.question,
          scope: {
            evidenceIds: normalized.scope.evidenceIds,
            personIds: normalized.scope.personIds,
          },
        },
        secret: runtime.hmacKey,
      });
      const result = await runPrincipalIdempotentResearchWrite(
        context,
        idempotency,
        requiredPermissions,
        async (scopedContext) => {
          await requireAuthorizedScope(scopedContext, normalized.scope);
          return createAiRepository(
            scopedContext.database,
            repositoryRuntime,
          ).insertStartedAnalysis({
            context: scopedContext,
            provider: runtime.provider.disclosure,
            baseUrlFingerprint: runtime.provider.baseUrlFingerprint,
            question: normalized.question,
            scope: normalized.scope,
          });
        },
      );
      const run = await readOwnedAiRun(
        String(result.responseReference.runId),
        requiredPermissions,
      );
      if (!run) {
        throw createGraphQLError(
          "NOT_FOUND",
          "The requested AI run was not found.",
        );
      }
      return run;
    },

    readAiRun,

    async cancelAiRun(id: string): Promise<AiRun | null> {
      const runId = validateRunId(id);
      return runResearchTransaction(
        context,
        { requiredPermissions: ["analysis:cancel"] },
        async (scopedContext) => {
          const repository = createAiRepository(
            scopedContext.database,
            repositoryRuntime,
          );
          const canceled = await repository.cancelOwnedRun({
            context: scopedContext,
            runId,
          });
          if (!canceled) return null;
          return publicProjection(
            scopedContext,
            await repository.readOwnedRun({
              principalId: scopedContext.actor.principalId,
              runId,
              workspaceId: scopedContext.workspaceId,
            }),
          );
        },
      );
    },
  };
}

export type { AiCitation, AiRun, AiScope, AiToolSummary } from "./repository";
