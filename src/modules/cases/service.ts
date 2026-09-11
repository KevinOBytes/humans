import { and, eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { cases, caseMembers, caseResourceLinks } from "@/db/schema/cases";
import { workspacePrincipals } from "@/db/schema/principals";
import { createGraphQLError } from "@/graphql/errors";
import { normalizePagination } from "@/graphql/limits";
import {
  canAccessResource,
  createAuditService,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { withResearchWriteTransaction } from "@/modules/audit/transactions";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import { normalizeGovernanceContext } from "@/modules/governance/validation";
import { createCasesRepository } from "./repository";
import { caseResourceKinds, type CaseResourceKind } from "./types";
import { normalizeCaseInput } from "./validation";

function permission(context: ResearchServiceContext, key: string) {
  if (!context.permissions.has(key))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}
export async function requireCaseResource(
  context: ResearchServiceContext,
  kind: CaseResourceKind,
  id: string,
) {
  if (!caseResourceKinds.includes(kind))
    throw createGraphQLError(
      "VALIDATION_FAILED",
      "The resource kind is invalid.",
    );
  permission(context, `${kind}:read`);
  permission(context, "person:read");
  const repository = createCasesRepository(context.database);
  const row = await repository.resource(context.workspaceId, kind, id);
  if (
    !row ||
    !(await canAccessResource(context.database, context, {
      id,
      resourceKind: kind,
      sensitivity: row.sensitivity,
    }))
  )
    throw createGraphQLError(
      "NOT_FOUND",
      "The requested resource was not found.",
    );
  for (const personId of row.personIds) {
    const person = await repository.resource(
      context.workspaceId,
      "person",
      personId,
    );
    if (
      !person ||
      !(await canAccessResource(context.database, context, {
        id: personId,
        resourceKind: "person",
        sensitivity: person.sensitivity,
      }))
    )
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
  }
  return row;
}
export async function requireResourceCoverage(
  context: ResearchServiceContext,
  row: Awaited<ReturnType<typeof requireCaseResource>>,
  purpose: string,
  caseReference: string | null,
  scope: "read" | "write",
) {
  const governance = normalizeGovernanceContext({
    governancePurpose: purpose,
    governanceCaseReference: caseReference,
  });
  for (const personId of row.personIds) {
    const coverage = await checkPurposeCoverage(context, {
      personId,
      purpose: governance.governancePurpose!,
      caseReference: governance.governanceCaseReference,
      scope,
      fieldDefinitionId: row.fieldDefinitionId,
      effectiveSensitivity: row.sensitivity,
    });
    if (!coverage.allowed)
      throw createGraphQLError(
        "FORBIDDEN",
        "Current purpose coverage is required.",
      );
  }
}
function cursor(at: Date, id: string) {
  return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString(
    "base64url",
  );
}
function afterCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as {
      at: string;
      id: string;
    };
    const at = new Date(parsed.at);
    if (!Number.isNaN(at.getTime()) && /^[\da-f-]{36}$/iu.test(parsed.id))
      return { at, id: parsed.id };
  } catch {}
  throw createGraphQLError("VALIDATION_FAILED", "The cursor is invalid.");
}
export function createCasesService(context: ResearchServiceContext) {
  const repository = createCasesRepository(context.database);
  const audit = createAuditService(context);
  const principalId = context.actor.principalId;
  async function requireCase(id: string, manage = false) {
    permission(context, "workspace:read");
    const row = await repository.get(context.workspaceId, id, principalId);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    if (manage && row.role !== "owner")
      throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
    return row.case;
  }
  return {
    async createCase(input: { title: string; purpose: string }) {
      permission(context, "workspace:update");
      const normalized = normalizeCaseInput(input);
      return withResearchWriteTransaction(context, async (database) => {
        const [row] = await database
          .insert(cases)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            ...normalized,
            createdBy: principalId,
            updatedBy: principalId,
          })
          .returning();
        if (!row) throw new Error("Case insert failed");
        await database.insert(caseMembers).values({
          id: newId(),
          workspaceId: context.workspaceId,
          caseId: row.id,
          principalId,
          role: "owner",
          createdBy: principalId,
          updatedBy: principalId,
        });
        await audit.write(database, {
          action: "case.create",
          resourceKind: "case",
          resourceId: row.id,
          changedFields: ["title", "purpose"],
        });
        return row;
      });
    },
    async addMember(input: {
      caseId: string;
      principalId: string;
      role?: string | null;
    }) {
      permission(context, "workspace:update");
      await requireCase(input.caseId, true);
      const role = input.role ?? "member";
      if (!["member", "reviewer"].includes(role))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The member role is invalid.",
        );
      return withResearchWriteTransaction(context, async (database) => {
        const [principal] = await database
          .select({ id: workspacePrincipals.id })
          .from(workspacePrincipals)
          .where(
            and(
              eq(workspacePrincipals.workspaceId, context.workspaceId),
              eq(workspacePrincipals.id, input.principalId),
            ),
          )
          .limit(1);
        if (!principal)
          throw createGraphQLError(
            "NOT_FOUND",
            "The requested resource was not found.",
          );
        const [row] = await database
          .insert(caseMembers)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            caseId: input.caseId,
            principalId: input.principalId,
            role,
            createdBy: principalId,
            updatedBy: principalId,
          })
          .returning();
        if (!row) throw new Error("Case member insert failed");
        await audit.write(database, {
          action: "case.member.add",
          resourceKind: "case",
          resourceId: input.caseId,
          changedFields: ["members"],
        });
        return row;
      });
    },
    async linkResource(input: {
      caseId: string;
      resourceKind: string;
      resourceId: string;
      explicitConfirmed: boolean;
      observedAt?: Date | string | null;
    }) {
      permission(context, "workspace:update");
      const caseRow = await requireCase(input.caseId, true);
      if (!input.explicitConfirmed || caseRow.state !== "active")
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "An active case and explicit confirmation are required.",
        );
      const observedAt =
        input.observedAt == null ? new Date() : new Date(input.observedAt);
      if (Number.isNaN(observedAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The date is invalid.");
      return withResearchWriteTransaction(context, async (database) => {
        const scoped = { ...context, database };
        const resource = await requireCaseResource(
          scoped,
          input.resourceKind as CaseResourceKind,
          input.resourceId,
        );
        await requireResourceCoverage(
          scoped,
          resource,
          caseRow.purpose,
          caseRow.id,
          "write",
        );
        const [row] = await database
          .insert(caseResourceLinks)
          .values({
            id: newId(),
            workspaceId: context.workspaceId,
            caseId: input.caseId,
            resourceKind: input.resourceKind,
            resourceId: input.resourceId,
            observedAt,
            createdBy: principalId,
            updatedBy: principalId,
          })
          .returning();
        if (!row) throw new Error("Case link insert failed");
        await audit.write(database, {
          action: "case.resource.link",
          resourceKind: "case",
          resourceId: input.caseId,
          changedFields: ["resources"],
        });
        return row;
      });
    },
    getCase: requireCase,
    async listCases(
      input: { first?: number | null; after?: string | null } = {},
    ) {
      permission(context, "workspace:read");
      const page = normalizePagination(input);
      const rows = await repository.list(
        context.workspaceId,
        principalId,
        page.first + 1,
        afterCursor(page.after),
      );
      const nodes = rows.slice(0, page.first).map((r) => r.case);
      const last = nodes.at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: rows.length > page.first,
          endCursor: last ? cursor(last.createdAt, last.id) : null,
        },
      };
    },
    async timeline(input: {
      caseId: string;
      first?: number | null;
      after?: string | null;
    }) {
      const row = await requireCase(input.caseId);
      const page = normalizePagination(input);
      // A bounded underlying page may be sparse after current authorization.
      const links = await repository.links(
        context.workspaceId,
        row.id,
        page.first + 1,
        afterCursor(page.after),
      );
      const nodes = [];
      for (const link of links.slice(0, page.first)) {
        try {
          const resource = await requireCaseResource(
            context,
            link.resourceKind as CaseResourceKind,
            link.resourceId,
          );
          await requireResourceCoverage(
            context,
            resource,
            row.purpose,
            row.id,
            "read",
          );
          nodes.push(link);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("extensions" in error) ||
            !["NOT_FOUND", "FORBIDDEN"].includes(
              (error.extensions as { code: string }).code,
            )
          )
            throw error;
        }
      }
      const last = links.slice(0, page.first).at(-1);
      return {
        nodes,
        pageInfo: {
          hasNextPage: links.length > page.first,
          endCursor: last ? cursor(last.observedAt, last.id) : null,
        },
      };
    },
  };
}
export type CasesService = ReturnType<typeof createCasesService>;
