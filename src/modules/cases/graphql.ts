import { builder } from "@/graphql/builder";
import { normalizePagination } from "@/graphql/limits";
import type { CaseRow, CaseMemberRow, CaseResourceLinkRow } from "./types";
import type { linkEvidenceAssertion } from "@/modules/evidence/assertions";

const Case = builder.objectRef<CaseRow>("ResearchCase").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    title: t.exposeString("title"),
    purpose: t.exposeString("purpose"),
    state: t.exposeString("state"),
    version: t.exposeInt("version"),
    createdAt: t.field({
      type: "DateTime",
      resolve: (row) => row.createdAt.toISOString(),
    }),
  }),
});
const Member = builder.objectRef<CaseMemberRow>("CaseMember").implement({
  fields: (t) => ({
    id: t.expose("id", { type: "UUID" }),
    principalId: t.expose("principalId", { type: "UUID" }),
    role: t.exposeString("role"),
    version: t.exposeInt("version"),
  }),
});
const Link = builder
  .objectRef<CaseResourceLinkRow>("CaseResourceLink")
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      resourceKind: t.exposeString("resourceKind"),
      resourceId: t.expose("resourceId", { type: "UUID" }),
      observedAt: t.field({
        type: "DateTime",
        resolve: (row) => row.observedAt.toISOString(),
      }),
    }),
  });
const Page = builder
  .objectRef<{ hasNextPage: boolean; endCursor: string | null }>("CasePageInfo")
  .implement({
    fields: (t) => ({
      hasNextPage: t.exposeBoolean("hasNextPage"),
      endCursor: t.exposeString("endCursor", { nullable: true }),
    }),
  });
const Cases = builder
  .objectRef<{
    nodes: CaseRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("ResearchCaseConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Case], resolve: (r) => r.nodes }),
      pageInfo: t.field({ type: Page, resolve: (r) => r.pageInfo }),
    }),
  });
const Timeline = builder
  .objectRef<{
    nodes: CaseResourceLinkRow[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  }>("CaseTimelineConnection")
  .implement({
    fields: (t) => ({
      nodes: t.field({ type: [Link], resolve: (r) => r.nodes }),
      pageInfo: t.field({ type: Page, resolve: (r) => r.pageInfo }),
    }),
  });
const Assertion = builder
  .objectRef<Awaited<ReturnType<typeof linkEvidenceAssertion>>>(
    "EvidenceAssertion",
  )
  .implement({
    fields: (t) => ({
      id: t.expose("id", { type: "UUID" }),
      evidenceId: t.expose("evidenceId", { type: "UUID" }),
      resourceKind: t.exposeString("resourceKind"),
      resourceId: t.expose("resourceId", { type: "UUID" }),
      locator: t.exposeString("locator"),
      quote: t.exposeString("quote"),
      role: t.exposeString("role"),
      confidence: t.float({ resolve: (r) => Number(r.confidence) }),
      informationCredibility: t.float({
        resolve: (r) => Number(r.informationCredibility),
      }),
      sourceReliability: t.float({
        nullable: true,
        resolve: (r) =>
          r.sourceReliability == null ? null : Number(r.sourceReliability),
      }),
      reviewState: t.exposeString("reviewState"),
      version: t.exposeInt("version"),
      auditReference: t.expose("auditReference", { type: "UUID" }),
    }),
  });
const AssertionInput = builder.inputType("LinkEvidenceAssertionInput", {
  fields: (t) => ({
    evidenceId: t.field({ type: "UUID", required: true }),
    resourceKind: t.string({ required: true }),
    resourceId: t.field({ type: "UUID", required: true }),
    locator: t.string({ required: true }),
    quote: t.string({ required: true }),
    role: t.string({ required: true }),
    confidence: t.float({ required: true }),
    purpose: t.string({ required: true }),
    caseId: t.field({ type: "UUID" }),
    explicitConfirmed: t.boolean({ required: true }),
    idempotencyKey: t.string(),
  }),
});

export function registerCasesGraphQL() {
  builder.queryFields((t) => ({
    researchCase: t.field({
      type: Case,
      args: { id: t.arg({ type: "UUID", required: true }) },
      resolve: (_r, a, c) => c.services.cases.getCase(a.id),
    }),
    researchCases: t.field({
      type: Cases,
      args: { first: t.arg.int(), after: t.arg.string() },
      complexity: (a) => ({
        field: 1,
        multiplier: normalizePagination(a).first,
      }),
      resolve: (_r, a, c) => c.services.cases.listCases(a),
    }),
    caseTimeline: t.field({
      type: Timeline,
      args: {
        caseId: t.arg({ type: "UUID", required: true }),
        first: t.arg.int(),
        after: t.arg.string(),
      },
      complexity: (a) => ({
        field: 1,
        multiplier: normalizePagination(a).first,
      }),
      resolve: (_r, a, c) => c.services.cases.timeline(a),
    }),
  }));
  builder.mutationFields((t) => ({
    createResearchCase: t.field({
      type: Case,
      args: {
        title: t.arg.string({ required: true }),
        purpose: t.arg.string({ required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_r, a, c) => c.services.cases.createCase(a),
    }),
    addCaseMember: t.field({
      type: Member,
      args: {
        caseId: t.arg({ type: "UUID", required: true }),
        principalId: t.arg({ type: "UUID", required: true }),
        role: t.arg.string(),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_r, a, c) => c.services.cases.addMember(a),
    }),
    linkCaseResource: t.field({
      type: Link,
      args: {
        caseId: t.arg({ type: "UUID", required: true }),
        resourceId: t.arg({ type: "UUID", required: true }),
        resourceKind: t.arg.string({ required: true }),
        explicitConfirmed: t.arg.boolean({ required: true }),
        observedAt: t.arg({ type: "DateTime" }),
        idempotencyKey: t.arg.string(),
      },
      resolve: async (_r, a, c) => {
        const result = await c.services.cases.linkResource(a);
        c.loaders.person.clearAll();
        c.loaders.fact.clearAll();
        c.loaders.relationship.clearAll();
        return result;
      },
    }),
    linkEvidenceAssertion: t.field({
      type: Assertion,
      args: { input: t.arg({ type: AssertionInput, required: true }) },
      resolve: (_r, a, c) => c.services.evidenceAssertions.link(a.input),
    }),
    reviewEvidenceAssertion: t.field({
      type: Assertion,
      args: {
        id: t.arg({ type: "UUID", required: true }),
        expectedVersion: t.arg.int({ required: true }),
        state: t.arg.string({ required: true }),
        reason: t.arg.string({ required: true }),
        idempotencyKey: t.arg.string(),
      },
      resolve: (_r, a, c) => c.services.evidenceAssertions.review(a),
    }),
  }));
}
