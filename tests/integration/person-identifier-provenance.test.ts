// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import {
  evidenceAssertions,
  evidenceItems,
  sources,
} from "@/db/schema/evidence";
import { auditEvents } from "@/db/schema/operations";
import { personIdentifiers } from "@/db/schema/people";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { linkEvidenceAssertion } from "@/modules/evidence/assertions";
import { createIdentifierService } from "@/modules/people/identifier-service";
import { LinkEvidenceAssertionDocument } from "@/graphql/generated/graphql";
import type { SessionActor } from "../support/graphql";
import { caseContext, coveredPerson } from "../support/cases";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("version-bound public identifier provenance", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let actor: SessionActor;
  let personId: string;
  let identifierId: string;
  let evidenceId: string;
  let sourceId: string;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
    context.protectedExactRuntime = {
      encryptionKey: "ac".repeat(32),
      blindIndexKey: "bc".repeat(32),
    };
    personId = (await coveredPerson(context)).id;
    const identifier = await createIdentifierService(context).createIdentifier({
      personId,
      namespace: "fictional-membership",
      identifierType: "Membership",
      value: "SYNTHETIC-PUBLIC-100",
      sensitivity: "public",
    });
    identifierId = identifier.resource!.id;
    sourceId = newId();
    evidenceId = newId();
    await fixture.database.insert(sources).values({
      id: sourceId,
      workspaceId: context.workspaceId,
      kind: "document",
      title: "Fictional directory",
      contentHash: "synthetic-source-hash",
      reliability: "0.800",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(evidenceItems).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      sourceId,
      checksum: "synthetic-evidence-hash",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
  });
  afterAll(async () => fixture.close());
  function input() {
    return {
      evidenceId,
      resourceKind: "person",
      resourceId: personId,
      fieldPath: `identifiers.${identifierId}.v1.value`,
      locator: "page 7",
      quote: "A fictional public membership",
      role: "supports",
      confidence: 0.8,
      purpose: "research",
      explicitConfirmed: true,
      idempotencyKey: "public-identifier-citation-v1",
    };
  }
  it("links and replays one versioned citation without copying or mutating source provenance", async () => {
    const [before] = await fixture.database
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId));
    const linked = await linkEvidenceAssertion(context, input());
    expect(await linkEvidenceAssertion(context, input())).toEqual(linked);
    expect(linked).toMatchObject({
      fieldPath: `identifiers.${identifierId}.v1.value`,
      evidenceId,
      sourceReliability: "0.800",
    });
    expect(
      await fixture.database
        .select()
        .from(sources)
        .where(eq(sources.id, sourceId)),
    ).toEqual([before]);
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(1);
    const events = await fixture.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "evidence.assertion.link"));
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("fictional public membership");
    expect(JSON.stringify(events)).not.toContain("page 7");
  });
  it("denies a citation targeting an identifier owned by another person", async () => {
    const other = await coveredPerson(context, { policy: false });
    await expect(
      linkEvidenceAssertion(context, { ...input(), resourceId: other.id }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(0);
  });
  it("denies a foreign-workspace identifier even when the selected person and evidence are visible", async () => {
    const foreign = await caseContext(fixture, await fixture.createActor());
    const foreignPerson = (await coveredPerson(foreign)).id;
    const created = await createIdentifierService(foreign).createIdentifier({
      personId: foreignPerson,
      namespace: "fictional",
      identifierType: "Membership",
      value: "foreign",
      sensitivity: "public",
    });
    await expect(
      linkEvidenceAssertion(context, {
        ...input(),
        fieldPath: `identifiers.${created.resource!.id}.v1.value`,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(0);
  });
  it("fails closed for protected identifiers without persisting the supplied plaintext quote", async () => {
    const created = await createIdentifierService(context).createIdentifier({
      personId,
      namespace: "fictional",
      identifierType: "Membership",
      value: "SYNTHETIC-PROTECTED-SECRET",
      sensitivity: "internal",
    });
    await expect(
      linkEvidenceAssertion(context, {
        ...input(),
        quote: "SYNTHETIC-PROTECTED-SECRET",
        fieldPath: `identifiers.${created.resource!.id}.v1.value`,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(0);
    const events = await fixture.database.select().from(auditEvents);
    expect(JSON.stringify(events)).not.toContain("SYNTHETIC-PROTECTED-SECRET");
  });
  it("rejects stale identifier versions and does not silently bind evidence to edited values", async () => {
    await createIdentifierService(context).updateIdentifier({
      id: identifierId,
      expectedVersion: 1,
      value: "SYNTHETIC-NEW-200",
    });
    await expect(linkEvidenceAssertion(context, input())).rejects.toMatchObject(
      { extensions: { code: "CONFLICT" } },
    );
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(0);
  });
  it("rechecks identifier authorization on idempotent replay after sensitivity changes", async () => {
    const linked = await linkEvidenceAssertion(context, input());
    await createIdentifierService(context).updateIdentifier({
      id: identifierId,
      expectedVersion: 1,
      sensitivity: "internal",
      value: "SYNTHETIC-PROTECTED-SECRET",
    });
    await expect(linkEvidenceAssertion(context, input())).rejects.toMatchObject(
      { extensions: { code: "PRECONDITION_FAILED" } },
    );
    const [stored] = await fixture.database
      .select()
      .from(evidenceAssertions)
      .where(eq(evidenceAssertions.id, linked.id));
    expect(stored!.fieldPath).toBe(`identifiers.${identifierId}.v1.value`);
  });
  it("rejects archived identifiers", async () => {
    await fixture.database
      .update(personIdentifiers)
      .set({ deletedAt: new Date() })
      .where(eq(personIdentifiers.id, identifierId));
    await expect(linkEvidenceAssertion(context, input())).rejects.toMatchObject(
      { extensions: { code: "NOT_FOUND" } },
    );
  });
  it("uses the generated GraphQL assertion operation and denies read-only authors", async () => {
    const response = await fixture.execute<{
      linkEvidenceAssertion: { fieldPath: string; evidenceId: string };
    }>({
      jar: actor.jar,
      query: LinkEvidenceAssertionDocument,
      operationName: "LinkEvidenceAssertion",
      variables: { input: input() },
    });
    expect(response.body?.errors).toBeUndefined();
    expect(response.body?.data?.linkEvidenceAssertion).toMatchObject({
      fieldPath: `identifiers.${identifierId}.v1.value`,
      evidenceId,
    });
    const viewer = await fixture.createWorkspaceMember(actor, "viewer");
    const denied = await fixture.execute({
      jar: viewer.jar,
      query: LinkEvidenceAssertionDocument,
      operationName: "LinkEvidenceAssertion",
      variables: {
        input: { ...input(), idempotencyKey: "viewer-denied-citation" },
      },
    });
    expect(denied.body?.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(1);
  });
});
