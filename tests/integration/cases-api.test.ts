// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { newId } from "@/db/id";
import { createCasesService } from "@/modules/cases/service";
import {
  canAccessResource,
  type ResearchServiceContext,
} from "@/modules/audit/service";
import { createGovernanceService } from "@/modules/governance/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";
import { expectGraphQLError } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe("case membership and resource boundary", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    context = await caseContext(fixture, await fixture.createActor());
  });
  afterAll(async () => fixture.close());
  it("does not disclose a case to a foreign workspace", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const row = await createCasesService(
      await caseContext(fixture, owner),
    ).createCase({ title: "Case", purpose: "research" });
    expectGraphQLError(
      await fixture.execute({
        jar: foreign.jar,
        query: "query($id: UUID!) { researchCase(id: $id) { id title } }",
        variables: { id: row.id },
      }),
      "NOT_FOUND",
    );
  });
  it("narrows existing resource access until case membership is added", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const ownerContext = await caseContext(fixture, owner);
    const memberContext = await caseContext(fixture, member);
    const person = await coveredPerson(ownerContext);
    const service = createCasesService(ownerContext);
    const row = await service.createCase({
      title: "Case",
      purpose: "research",
    });
    const resource = {
      resourceKind: "person",
      id: person.id,
      sensitivity: "internal" as const,
    };
    expect(
      await canAccessResource(fixture.database, memberContext, resource),
    ).toBe(true);
    await service.linkResource({
      caseId: row.id,
      resourceKind: "person",
      resourceId: person.id,
      explicitConfirmed: true,
    });
    expect(
      await canAccessResource(fixture.database, memberContext, resource),
    ).toBe(false);
    await service.addMember({
      caseId: row.id,
      principalId: member.principalId,
    });
    expect(
      await canAccessResource(fixture.database, memberContext, resource),
    ).toBe(true);
  });
  it("rejects foreign resources and missing confirmation", async () => {
    const foreign = await caseContext(fixture, await fixture.createActor());
    const person = await coveredPerson(foreign);
    const service = createCasesService(context);
    const row = await service.createCase({
      title: "Case",
      purpose: "research",
    });
    await expect(
      service.linkResource({
        caseId: row.id,
        resourceKind: "person",
        resourceId: person.id,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
    await expect(
      service.linkResource({
        caseId: row.id,
        resourceKind: "person",
        resourceId: person.id,
        explicitConfirmed: false,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
  });
  it("withdrawn consent prevents linking and removes timeline content", async () => {
    const person = await coveredPerson(context);
    const service = createCasesService(context);
    const row = await service.createCase({
      title: "Case",
      purpose: "research",
    });
    await service.linkResource({
      caseId: row.id,
      resourceKind: "person",
      resourceId: person.id,
      explicitConfirmed: true,
    });
    expect((await service.timeline({ caseId: row.id })).nodes).toHaveLength(1);
    await createGovernanceService(context).withdrawConsent({
      idempotencyKey: newId(),
      id: person.consentId,
      expectedVersion: 1,
    });
    expect((await service.timeline({ caseId: row.id })).nodes).toHaveLength(0);
    await expect(
      service.linkResource({
        caseId: row.id,
        resourceKind: "person",
        resourceId: person.id,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "FORBIDDEN" } });
  });
  it("membership never grants restricted baseline access", async () => {
    const person = await coveredPerson(context, { sensitivity: "restricted" });
    const service = createCasesService(context);
    const row = await service.createCase({
      title: "Case",
      purpose: "research",
    });
    await expect(
      service.linkResource({
        caseId: row.id,
        resourceKind: "person",
        resourceId: person.id,
        explicitConfirmed: true,
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
});
