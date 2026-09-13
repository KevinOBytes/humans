import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import { caseMembers, cases } from "@/db/schema/cases";
import {
  investigationCaseLinks,
  investigationSequences,
  investigations,
} from "@/db/schema/investigations";
import { workspacePrincipals } from "@/db/schema/principals";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import type { InvestigationCaseLinkRow, InvestigationRow } from "./types";

const STATES = ["draft", "active", "paused", "closed", "archived"] as const;
const SENSITIVITIES = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SLUG = /^[a-z0-9][a-z0-9-]{0,95}$/u;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;

function permission(context: ResearchServiceContext, key: string): void {
  if (!context.permissions.has(key))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

function text(value: unknown, label: string, max: number): string {
  const result =
    typeof value === "string" ? value.normalize("NFKC").trim() : "";
  if (
    result.length === 0 ||
    result.length > max ||
    /[\u0000-\u001f\u007f]/u.test(result)
  )
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  return result;
}

function date(value: unknown, label: string): Date | null {
  if (value == null) return null;
  const result =
    value instanceof Date ? new Date(value) : new Date(String(value));
  if (Number.isNaN(result.getTime()))
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  return result;
}

function enumValue<T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
  fallback: T[number],
): T[number] {
  const selected = value == null ? fallback : String(value);
  if (!values.includes(selected))
    throw createGraphQLError("VALIDATION_FAILED", `${label} is invalid.`);
  return selected as T[number];
}

function slug(value: unknown): string | null {
  if (value == null || (typeof value === "string" && value.trim() === ""))
    return null;
  const normalized = String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!SLUG.test(normalized))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The investigation slug is invalid.",
    );
  return normalized;
}

function cursor(row: Pick<InvestigationRow, "createdAt" | "id">): string {
  return Buffer.from(
    JSON.stringify({ v: 1, t: row.createdAt.toISOString(), i: row.id }),
    "utf8",
  ).toString("base64url");
}

function afterCursor(
  value: string | null | undefined,
): { at: Date; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      v?: number;
      t?: string;
      i?: string;
    };
    const at = new Date(parsed.t ?? "");
    if (
      parsed.v !== 1 ||
      !UUID.test(parsed.i ?? "") ||
      Number.isNaN(at.getTime())
    )
      throw new Error("invalid");
    return { at, id: parsed.i! };
  } catch {
    throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
  }
}

function idempotency(
  context: ResearchServiceContext,
  input: {
    key: string;
    operation: string;
    material: Readonly<Record<string, CanonicalRequestMaterial>>;
  },
) {
  if (!context.idempotencyHmacKey)
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "Investigation mutation idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.key,
    operation: input.operation,
    requestMaterial: input.material,
    secret: context.idempotencyHmacKey,
  });
}

function referenceUuid(
  reference: ResearchResponseReference,
  key: string,
): string {
  const value = reference[key];
  if (typeof value !== "string" || !UUID.test(value))
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      "The stored investigation mutation result is invalid.",
    );
  return value;
}

function isWorkspaceManager(context: ResearchServiceContext): boolean {
  return (
    context.actor.type === "user" &&
    (context.actor.role === "owner" || context.actor.role === "admin")
  );
}

export function createInvestigationsService(context: ResearchServiceContext) {
  const audit = createAuditService(context);
  const principalId = context.actor.principalId;

  async function get(id: string): Promise<InvestigationRow> {
    permission(context, "investigation:read");
    if (!UUID.test(id))
      throw createGraphQLError(
        "VALIDATION_FAILED",
        "The investigation id is invalid.",
      );
    const [row] = await context.database
      .select()
      .from(investigations)
      .where(
        and(
          eq(investigations.workspaceId, context.workspaceId),
          eq(investigations.id, id),
          isNull(investigations.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested investigation was not found.",
      );
    return row;
  }

  async function replayInvestigation(
    reference: ResearchResponseReference,
  ): Promise<InvestigationRow> {
    return get(referenceUuid(reference, "investigationId"));
  }

  async function replayLink(
    reference: ResearchResponseReference,
  ): Promise<InvestigationCaseLinkRow> {
    permission(context, "investigation:read");
    const id = referenceUuid(reference, "linkId");
    const [row] = await context.database
      .select()
      .from(investigationCaseLinks)
      .where(
        and(
          eq(investigationCaseLinks.workspaceId, context.workspaceId),
          eq(investigationCaseLinks.id, id),
          isNull(investigationCaseLinks.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested investigation case link was not found.",
      );
    return row;
  }

  return {
    async getInvestigation(id: string) {
      return get(id);
    },

    async listInvestigations(
      input: { first?: number | null; after?: string | null } = {},
    ) {
      permission(context, "investigation:read");
      const { first } = normalizePagination(input);
      const after = afterCursor(input.after);
      const rows = await context.database
        .select()
        .from(investigations)
        .where(
          and(
            eq(investigations.workspaceId, context.workspaceId),
            isNull(investigations.deletedAt),
            after
              ? or(
                  lt(investigations.createdAt, after.at),
                  and(
                    eq(investigations.createdAt, after.at),
                    lt(investigations.id, after.id),
                  ),
                )
              : undefined,
          ),
        )
        .orderBy(desc(investigations.createdAt), desc(investigations.id))
        .limit(first + 1);
      const nodes = rows.slice(0, first);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > first,
          endCursor: last ? cursor(last) : null,
        },
      };
    },

    async createInvestigation(input: {
      slug?: string | null;
      title: string;
      objective: string;
      purpose: string;
      sensitivity?: string | null;
      state?: string | null;
      leadPrincipalId?: string | null;
      startedAt?: Date | string | null;
      endedAt?: Date | string | null;
      idempotencyKey?: string | null;
    }) {
      permission(context, "investigation:create");
      const normalized = {
        requestedSlug: slug(input.slug),
        title: text(input.title, "The investigation title", 200),
        objective: text(input.objective, "The investigation objective", 4_000),
        purpose: text(input.purpose, "The investigation purpose", 2_000),
        sensitivity: enumValue(
          input.sensitivity,
          SENSITIVITIES,
          "The investigation sensitivity",
          "internal",
        ),
        state: enumValue(
          input.state,
          STATES,
          "The investigation state",
          "draft",
        ),
        leadPrincipalId: input.leadPrincipalId ?? principalId,
        startedAt: date(input.startedAt, "The investigation start date"),
        endedAt: date(input.endedAt, "The investigation end date"),
      };
      if (!UUID.test(normalized.leadPrincipalId))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The investigation lead is invalid.",
        );
      if (
        normalized.endedAt &&
        normalized.startedAt &&
        normalized.endedAt < normalized.startedAt
      )
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The investigation end date cannot precede its start date.",
        );
      if (normalized.state === "closed")
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "A new investigation must be opened before it can be closed.",
        );
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "investigation.create.graphql",
            material: normalized as unknown as Readonly<
              Record<string, CanonicalRequestMaterial>
            >,
          }),
          ["investigation:create"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createInvestigationsService(
              scopedContext,
            ).createInvestigation({
              ...input,
              idempotencyKey: null,
            });
            return { investigationId: row.id };
          },
        );
        return replayInvestigation(executed.responseReference);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const [sequence] = await database
          .insert(investigationSequences)
          .values({ workspaceId: context.workspaceId, nextNumber: 2 })
          .onConflictDoUpdate({
            target: investigationSequences.workspaceId,
            set: { nextNumber: sql`${investigationSequences.nextNumber} + 1` },
          })
          .returning({ nextNumber: investigationSequences.nextNumber });
        const number = sequence?.nextNumber ? sequence.nextNumber - 1 : 1;
        const generatedSlug = `inv-${number}-${normalized.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, 80)}`;
        const [lead] = await database
          .select({ id: workspacePrincipals.id })
          .from(workspacePrincipals)
          .where(
            and(
              eq(workspacePrincipals.workspaceId, context.workspaceId),
              eq(workspacePrincipals.id, normalized.leadPrincipalId),
            ),
          )
          .limit(1);
        if (!lead)
          throw createGraphQLError(
            "NOT_FOUND",
            "The investigation lead was not found in this workspace.",
          );
        const [row] = await database
          .insert(investigations)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            number,
            slug: normalized.requestedSlug ?? generatedSlug,
            title: normalized.title,
            objective: normalized.objective,
            purpose: normalized.purpose,
            sensitivity: normalized.sensitivity,
            state: normalized.state,
            leadPrincipalId: normalized.leadPrincipalId,
            startedAt: normalized.startedAt,
            endedAt: normalized.endedAt,
            createdBy: principalId,
            updatedBy: principalId,
          })
          .returning();
        if (!row) throw new Error("Investigation insert failed");
        await audit.write(database, {
          action: "investigation.create",
          resourceKind: "investigation",
          resourceId: row.id,
          changedFields: [
            "number",
            "slug",
            "title",
            "objective",
            "purpose",
            "sensitivity",
            "state",
            "leadPrincipalId",
          ],
        });
        return row;
      });
    },

    async linkCase(input: {
      investigationId: string;
      caseId: string;
      idempotencyKey?: string | null;
    }) {
      permission(context, "investigation:update");
      await get(input.investigationId);
      if (!UUID.test(input.caseId))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The case id is invalid.",
        );
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "investigation.case.link.graphql",
            material: {
              investigationId: input.investigationId,
              caseId: input.caseId,
            },
          }),
          ["investigation:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createInvestigationsService(
              scopedContext,
            ).linkCase({
              ...input,
              idempotencyKey: null,
            });
            return { investigationId: input.investigationId, linkId: row.id };
          },
        );
        return replayLink(executed.responseReference);
      }
      return withResearchWriteTransaction(context, async (database) => {
        const manager = isWorkspaceManager(context);
        const [caseRow] = await database
          .select({ id: cases.id })
          .from(cases)
          .leftJoin(
            caseMembers,
            and(
              eq(caseMembers.workspaceId, cases.workspaceId),
              eq(caseMembers.caseId, cases.id),
              eq(caseMembers.principalId, principalId),
              isNull(caseMembers.deletedAt),
            ),
          )
          .where(
            and(
              eq(cases.workspaceId, context.workspaceId),
              eq(cases.id, input.caseId),
              isNull(cases.deletedAt),
              manager ? undefined : sql`${caseMembers.id} IS NOT NULL`,
            ),
          )
          .limit(1);
        if (!caseRow)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested case was not found.",
          );
        const [existing] = await database
          .select()
          .from(investigationCaseLinks)
          .where(
            and(
              eq(investigationCaseLinks.workspaceId, context.workspaceId),
              eq(investigationCaseLinks.investigationId, input.investigationId),
              eq(investigationCaseLinks.caseId, input.caseId),
            ),
          )
          .limit(1);
        const row = existing
          ? (
              await database
                .update(investigationCaseLinks)
                .set({
                  deletedAt: null,
                  deletedBy: null,
                  updatedAt: new Date(),
                  updatedBy: principalId,
                  version: sql`${investigationCaseLinks.version} + 1`,
                })
                .where(eq(investigationCaseLinks.id, existing.id))
                .returning()
            )[0]
          : (
              await database
                .insert(investigationCaseLinks)
                .values({
                  id: newId(),
                  workspaceId: context.workspaceId,
                  investigationId: input.investigationId,
                  caseId: input.caseId,
                  createdBy: principalId,
                  updatedBy: principalId,
                })
                .returning()
            )[0];
        if (!row) throw new Error("Investigation case link insert failed");
        await audit.write(database, {
          action: "investigation.case.link",
          resourceKind: "investigation",
          resourceId: input.investigationId,
          changedFields: ["caseLinks"],
        });
        return row;
      });
    },

    async listCaseLinks(input: { investigationId: string }) {
      await get(input.investigationId);
      const manager = isWorkspaceManager(context);
      return context.database
        .select({ link: investigationCaseLinks })
        .from(investigationCaseLinks)
        .innerJoin(
          cases,
          and(
            eq(cases.workspaceId, investigationCaseLinks.workspaceId),
            eq(cases.id, investigationCaseLinks.caseId),
          ),
        )
        .leftJoin(
          caseMembers,
          and(
            eq(caseMembers.workspaceId, cases.workspaceId),
            eq(caseMembers.caseId, cases.id),
            eq(caseMembers.principalId, principalId),
            isNull(caseMembers.deletedAt),
          ),
        )
        .where(
          and(
            eq(investigationCaseLinks.workspaceId, context.workspaceId),
            eq(investigationCaseLinks.investigationId, input.investigationId),
            isNull(investigationCaseLinks.deletedAt),
            isNull(cases.deletedAt),
            manager ? undefined : sql`${caseMembers.id} IS NOT NULL`,
          ),
        )
        .orderBy(
          desc(investigationCaseLinks.createdAt),
          desc(investigationCaseLinks.id),
        )
        .then((rows) => rows.map((row) => row.link));
    },
  };
}

export type InvestigationsService = ReturnType<
  typeof createInvestigationsService
>;
