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
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import type { ResearchServiceContext } from "@/modules/audit/service";
import {
  linkEvidenceAssertion,
  createEvidenceAssertionsService,
} from "@/modules/evidence/assertions";
import {
  createIdentifierService,
  prepareIdentifierWrite,
} from "@/modules/people/identifier-service";
import {
  LinkEvidenceAssertionDocument,
  PersonIdentifierCitationsDocument,
} from "@/graphql/generated/graphql";
import { createCasesService } from "@/modules/cases/service";
import { cases } from "@/db/schema/cases";
import { people } from "@/db/schema/people";
import { consentRecords } from "@/db/schema/privacy";
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
      canonicalUrl: "https://example.test/directory",
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
  const readbackQuery = PersonIdentifierCitationsDocument;
  function readback(first = 25, after?: string) {
    return createEvidenceAssertionsService(
      context,
    ).listPersonIdentifierCitations({ personId, first, after });
  }
  it("reads authorized public metadata through GraphQL and paginates without identifier values", async () => {
    const linked = await linkEvidenceAssertion(context, input());
    await linkEvidenceAssertion(context, {
      ...input(),
      idempotencyKey: "second-citation",
      locator: "page 8",
    });
    const first = await readback(1);
    expect(first.nodes).toHaveLength(1);
    expect(first.pageInfo.hasNextPage).toBe(true);
    const next = await readback(1, first.pageInfo.endCursor!);
    expect(next.nodes).toHaveLength(1);
    expect(next.nodes[0]!.id).not.toBe(first.nodes[0]!.id);
    expect(next.pageInfo.hasNextPage).toBe(false);
    const response = await fixture.execute({
      jar: actor.jar,
      query: readbackQuery,
      variables: { personId },
    });
    expect(response.body?.errors).toBeUndefined();
    expect(JSON.stringify(response.body)).toContain(linked.id);
    expect(JSON.stringify(response.body)).toContain("Fictional directory");
    expect(JSON.stringify(response.body)).not.toContain("SYNTHETIC-PUBLIC-100");
    expect(first.nodes[0]).toMatchObject({
      identifierId,
      identifierVersion: 1,
      field: "value",
      sourceReliability: "0.800",
      reviewState: "unreviewed",
    });
  });
  it("denies cross-workspace person reads", async () => {
    await linkEvidenceAssertion(context, input());
    const foreign = await caseContext(fixture, await fixture.createActor());
    await expect(
      createEvidenceAssertionsService(foreign).listPersonIdentifierCitations({
        personId,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
  it.each(["source", "evidence", "identifier", "person"])(
    "omits a citation after its %s is hidden",
    async (kind) => {
      await linkEvidenceAssertion(context, input());
      if (kind === "source")
        await fixture.database
          .update(sources)
          .set({ sensitivity: "restricted" })
          .where(eq(sources.id, sourceId));
      if (kind === "evidence")
        await fixture.database
          .update(evidenceItems)
          .set({ sensitivity: "restricted" })
          .where(eq(evidenceItems.id, evidenceId));
      if (kind === "identifier")
        await fixture.database
          .update(personIdentifiers)
          .set({ deletedAt: new Date() })
          .where(eq(personIdentifiers.id, identifierId));
      if (kind === "person") {
        const foreignPerson = (await coveredPerson(context, { policy: false }))
          .id;
        await fixture.database
          .update(evidenceAssertions)
          .set({ resourceId: foreignPerson })
          .where(eq(evidenceAssertions.resourceId, personId));
      }
      expect((await readback()).nodes).toEqual([]);
    },
  );
  it.each([
    "!invalid",
    "a".repeat(1025),
    Buffer.from(JSON.stringify({ v: 1, id: "invalid" })).toString("base64url"),
  ])("rejects malformed cursor %s", async (after) => {
    await expect(readback(1, after)).rejects.toMatchObject({
      extensions: { code: "VALIDATION_FAILED" },
    });
  });
  it("does not rebind stale citations to the edited identifier", async () => {
    await linkEvidenceAssertion(context, input());
    await createIdentifierService(context).updateIdentifier({
      id: identifierId,
      expectedVersion: 1,
      value: "SYNTHETIC-NEW-200",
    });
    expect((await readback()).nodes).toEqual([]);
  });
  it("denies a hidden parent person instead of disclosing citation metadata", async () => {
    await linkEvidenceAssertion(context, input());
    await fixture.database
      .update(people)
      .set({ sensitivity: "restricted" })
      .where(eq(people.id, personId));
    await expect(readback()).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
  it("omits citations bound to an archived case", async () => {
    const researchCase = await createCasesService(context).createCase({
      title: "Citation case",
      purpose: "research",
    });
    await linkEvidenceAssertion(context, {
      ...input(),
      caseId: researchCase.id,
    });
    expect((await readback()).nodes).toHaveLength(1);
    await fixture.database
      .update(cases)
      .set({ deletedAt: new Date() })
      .where(eq(cases.id, researchCase.id));
    expect((await readback()).nodes).toEqual([]);
  });
  it("omits a private case citation for an unrelated workspace viewer", async () => {
    const researchCase = await createCasesService(context).createCase({
      title: "Private citation case",
      purpose: "research",
    });
    await linkEvidenceAssertion(context, {
      ...input(),
      caseId: researchCase.id,
    });
    const viewer = await fixture.createWorkspaceMember(actor, "viewer");
    const response = await fixture.execute<{
      personIdentifierCitations: { nodes: unknown[] };
    }>({ jar: viewer.jar, query: readbackQuery, variables: { personId } });
    expect(response.body?.errors).toBeUndefined();
    expect(response.body?.data?.personIdentifierCitations.nodes).toEqual([]);
  });
  it("omits citations when current purpose coverage has expired", async () => {
    await linkEvidenceAssertion(context, input());
    await fixture.database
      .update(consentRecords)
      .set({ effectiveUntil: new Date(Date.now() - 1000) })
      .where(eq(consentRecords.personId, personId));
    expect((await readback()).nodes).toEqual([]);
  });
  it.each([0, 101, -1, 1.5])(
    "rejects out-of-bounds page size %s",
    async (first) => {
      await expect(readback(first)).rejects.toMatchObject({
        extensions: { code: "VALIDATION_FAILED" },
      });
    },
  );
  it("binds sealed cursors to the person and rejects tampering", async () => {
    await linkEvidenceAssertion(context, input());
    const cursor = (await readback(1)).pageInfo.endCursor!;
    expect(Buffer.from(cursor, "base64url").toString()).not.toContain(
      identifierId,
    );
    const other = (await coveredPerson(context, { policy: false })).id;
    await expect(
      createEvidenceAssertionsService(context).listPersonIdentifierCitations({
        personId: other,
        after: cursor,
      }),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
    await expect(
      readback(1, `${cursor.slice(0, -4)}AAAA`),
    ).rejects.toMatchObject({ extensions: { code: "VALIDATION_FAILED" } });
  });
  it("omits malformed legacy paths and returns no unsafe source links", async () => {
    const linked = await linkEvidenceAssertion(context, input());
    await fixture.database
      .update(sources)
      .set({ canonicalUrl: "javascript:alert(1)" })
      .where(eq(sources.id, sourceId));
    expect((await readback()).nodes[0]?.sourceUrl).toBeNull();
    await fixture.database
      .update(evidenceAssertions)
      .set({ fieldPath: `identifiers.${identifierId}.v01.value` })
      .where(eq(evidenceAssertions.id, linked.id));
    expect((await readback()).nodes).toEqual([]);
  });
  it("fails closed after out-of-band protected reclassification, even for visible internal rows", async () => {
    await linkEvidenceAssertion(context, {
      ...input(),
      quote: "SYNTHETIC-PUBLIC-100",
    });
    await fixture.database
      .update(personIdentifiers)
      .set({ sensitivity: "internal" })
      .where(eq(personIdentifiers.id, identifierId));
    const response = await fixture.execute({
      jar: actor.jar,
      query: readbackQuery,
      variables: { personId },
    });
    expect(response.body?.errors).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain("SYNTHETIC-PUBLIC-100");
    expect((await readback()).nodes).toEqual([]);
  });
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
  it("reaches the protected-storage precondition for an explicitly granted confidential identifier", async () => {
    const created = await createIdentifierService(context).createIdentifier({
      personId,
      namespace: "fictional",
      identifierType: "Membership",
      value: "SYNTHETIC-PROTECTED-SECRET",
      sensitivity: "internal",
    });
    const protectedId = created.resource!.id;
    const policyId = newId();
    await fixture.database.insert(accessPolicies).values({
      id: policyId,
      workspaceId: context.workspaceId,
      name: "Citation fixture readers",
      sensitivityCeiling: "confidential",
      resourceKinds: ["personIdentifier"],
      state: "active",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    await fixture.database.insert(resourceGrants).values({
      id: newId(),
      workspaceId: context.workspaceId,
      policyId,
      memberId: actor.memberId,
      resourceKind: "personIdentifier",
      resourceId: protectedId,
      state: "active",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    const changed = await createIdentifierService(context).updateIdentifier({
      id: protectedId,
      expectedVersion: 1,
      sensitivity: "confidential",
      value: "SYNTHETIC-PROTECTED-SECRET",
    });
    expect(changed.resource?.sensitivity).toBe("confidential");
    await expect(
      linkEvidenceAssertion(context, {
        ...input(),
        fieldPath: `identifiers.${protectedId}.v2.value`,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(
      await fixture.database.select().from(evidenceAssertions),
    ).toHaveLength(0);
  });
  it.each([undefined, "SYNTHETIC-PUBLIC-100", "SYNTHETIC-REPLACEMENT-200"])(
    "rejects reclassifying a cited public identifier with replacement %s",
    async (value) => {
      const quote = "SYNTHETIC-PUBLIC-100";
      await linkEvidenceAssertion(context, { ...input(), quote });
      await expect(
        createIdentifierService(context).updateIdentifier({
          id: identifierId,
          expectedVersion: 1,
          sensitivity: "internal",
          value,
          idempotencyKey: "cited-identifier-reclassification",
        }),
      ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
      const [stored] = await fixture.database
        .select()
        .from(personIdentifiers)
        .where(eq(personIdentifiers.id, identifierId));
      expect(stored).toMatchObject({
        version: 1,
        sensitivity: "public",
        normalizedValue: quote,
        encryptedRawValue: null,
        blindIndex: null,
      });
      const assertions = await fixture.database
        .select()
        .from(evidenceAssertions);
      expect(assertions).toHaveLength(1);
      expect(assertions[0]!.quote).toBe(quote);
      const events = await fixture.database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "personIdentifier.update"));
      expect(events).toHaveLength(0);
    },
  );
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
  it("rechecks identifier authorization on idempotent replay after an out-of-band sensitivity change", async () => {
    const linked = await linkEvidenceAssertion(context, input());
    // The authoring API rejects this transition once cited. Simulate a legacy
    // or out-of-band database change to exercise replay's independent guard.
    await fixture.database
      .update(personIdentifiers)
      .set({
        ...prepareIdentifierWrite(
          {
            namespace: "fictional-membership",
            identifierType: "Membership",
            sensitivity: "internal",
            value: "SYNTHETIC-PROTECTED-SECRET",
          },
          context,
        ),
        version: 2,
      })
      .where(eq(personIdentifiers.id, identifierId));
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
