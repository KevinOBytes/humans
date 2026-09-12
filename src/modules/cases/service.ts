import { and, eq, isNull } from "drizzle-orm";
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
import {
  derivePrincipalResearchIdempotency,
  runPrincipalIdempotentResearchWrite,
  withResearchWriteTransaction,
  type CanonicalRequestMaterial,
  type ResearchResponseReference,
} from "@/modules/audit/transactions";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import { normalizeGovernanceContext } from "@/modules/governance/validation";
import { createCasesRepository } from "./repository";
import { caseResourceKinds, type CaseResourceKind } from "./types";
import { normalizeCaseInput } from "./validation";

function permission(context: ResearchServiceContext, key: string) {
  if (!context.permissions.has(key))
    throw createGraphQLError("FORBIDDEN", "This operation is not permitted.");
}

const CASE_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const CASE_REFERENCE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
      "Case mutation idempotency is not configured.",
    );
  return derivePrincipalResearchIdempotency(context, {
    expiresAt: new Date(Date.now() + CASE_IDEMPOTENCY_TTL_MS),
    idempotencyKey: input.key,
    operation: input.operation,
    requestMaterial: input.material,
    secret: context.idempotencyHmacKey,
  });
}

function referenceUuid(
  reference: ResearchResponseReference,
  key: string,
  label: string,
): string {
  const value = reference[key];
  if (typeof value !== "string" || !CASE_REFERENCE_UUID.test(value))
    throw createGraphQLError(
      "PRECONDITION_FAILED",
      `The stored ${label} mutation result is invalid.`,
    );
  return value.toLowerCase();
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
  async function replayCase(
    reference: ResearchResponseReference,
  ): Promise<typeof cases.$inferSelect> {
    const id = referenceUuid(reference, "caseId", "case");
    const [row] = await context.database
      .select()
      .from(cases)
      .where(
        and(
          eq(cases.workspaceId, context.workspaceId),
          eq(cases.id, id),
          isNull(cases.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }
  async function replayMember(
    reference: ResearchResponseReference,
    caseId: string,
  ): Promise<typeof caseMembers.$inferSelect> {
    await requireCase(caseId, true);
    const id = referenceUuid(reference, "memberId", "case member");
    const [row] = await context.database
      .select()
      .from(caseMembers)
      .where(
        and(
          eq(caseMembers.workspaceId, context.workspaceId),
          eq(caseMembers.id, id),
          eq(caseMembers.caseId, caseId),
          isNull(caseMembers.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    return row;
  }
  async function replayLink(
    reference: ResearchResponseReference,
    caseId: string,
  ): Promise<typeof caseResourceLinks.$inferSelect> {
    const caseRow = await requireCase(caseId, true);
    const id = referenceUuid(reference, "linkId", "case resource link");
    const [row] = await context.database
      .select()
      .from(caseResourceLinks)
      .where(
        and(
          eq(caseResourceLinks.workspaceId, context.workspaceId),
          eq(caseResourceLinks.id, id),
          eq(caseResourceLinks.caseId, caseId),
          isNull(caseResourceLinks.deletedAt),
        ),
      )
      .limit(1);
    if (!row)
      throw createGraphQLError(
        "NOT_FOUND",
        "The requested resource was not found.",
      );
    const resource = await requireCaseResource(
      context,
      row.resourceKind as CaseResourceKind,
      row.resourceId,
    );
    await requireResourceCoverage(
      context,
      resource,
      caseRow.purpose,
      caseRow.id,
      "write",
    );
    return row;
  }
  return {
    async createCase(input: {
      title: string;
      purpose: string;
      idempotencyKey?: string | null;
    }) {
      permission(context, "workspace:update");
      const normalized = normalizeCaseInput(input);
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "case.create.graphql",
            material: normalized as unknown as Readonly<
              Record<string, CanonicalRequestMaterial>
            >,
          }),
          ["workspace:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createCasesService(scopedContext).createCase({
              ...input,
              idempotencyKey: null,
            });
            return { caseId: row.id };
          },
        );
        return replayCase(executed.responseReference);
      }
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
      idempotencyKey?: string | null;
    }) {
      permission(context, "workspace:update");
      const role = input.role ?? "member";
      if (!["member", "reviewer"].includes(role))
        throw createGraphQLError(
          "VALIDATION_FAILED",
          "The member role is invalid.",
        );
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "case.member.add.graphql",
            material: {
              caseId: input.caseId,
              principalId: input.principalId,
              role,
            },
          }),
          ["workspace:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createCasesService(scopedContext).addMember({
              ...input,
              idempotencyKey: null,
            });
            return { caseId: input.caseId, memberId: row.id };
          },
        );
        return replayMember(executed.responseReference, input.caseId);
      }
      await requireCase(input.caseId, true);
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
      idempotencyKey?: string | null;
    }) {
      permission(context, "workspace:update");
      const observedAt =
        input.observedAt == null ? new Date() : new Date(input.observedAt);
      if (Number.isNaN(observedAt.getTime()))
        throw createGraphQLError("VALIDATION_FAILED", "The date is invalid.");
      if (input.idempotencyKey != null) {
        const executed = await runPrincipalIdempotentResearchWrite(
          context,
          idempotency(context, {
            key: input.idempotencyKey,
            operation: "case.resource.link.graphql",
            material: {
              caseId: input.caseId,
              explicitConfirmed: input.explicitConfirmed,
              observedAt: observedAt.toISOString(),
              resourceId: input.resourceId,
              resourceKind: input.resourceKind,
            },
          }),
          ["workspace:update"],
          async (scopedContext): Promise<ResearchResponseReference> => {
            const row = await createCasesService(scopedContext).linkResource({
              ...input,
              observedAt,
              idempotencyKey: null,
            });
            return { caseId: input.caseId, linkId: row.id };
          },
        );
        return replayLink(executed.responseReference, input.caseId);
      }
      const caseRow = await requireCase(input.caseId, true);
      if (!input.explicitConfirmed || caseRow.state !== "active")
        throw createGraphQLError(
          "PRECONDITION_FAILED",
          "An active case and explicit confirmation are required.",
        );
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
