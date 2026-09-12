// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditEvents } from "@/db/schema/operations";
import { caseMembers, caseResourceLinks } from "@/db/schema/cases";
import { locationMutationIdempotency } from "@/db/schema/locations";
import {
  AddCaseMemberDocument,
  CreateResearchCaseDocument,
  LinkCaseResourceDocument,
} from "@/graphql/generated/graphql";
import { caseContext, coveredPerson } from "../support/cases";
import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("generated case mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("replays case creation, membership, and resource linking with one audited effect", async () => {
    const owner = await fixture.createActor();
    const member = await fixture.createWorkspaceMember(owner, "analyst");
    const ownerContext = await caseContext(fixture, owner);
    const person = await coveredPerson(ownerContext);

    const create = (title: string, key = "case-create-replay-v1") =>
      fixture.execute<{
        createResearchCase: {
          id: string;
          title: string;
          version: number;
        };
      }>({
        jar: owner.jar,
        operationName: "CreateResearchCase",
        query: CreateResearchCaseDocument,
        variables: {
          title,
          purpose: "research",
          idempotencyKey: key,
        },
      });

    const [first, replay] = await Promise.all([
      create("Replay case"),
      create("Replay case"),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const created = required(
      first.body?.data?.createResearchCase,
      "created case",
    );
    expect(replay.body?.data?.createResearchCase).toEqual(created);

    const caseCreateAudits = await fixture.database
      .select({ id: auditEvents.id })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "case.create"),
        ),
      );
    expect(caseCreateAudits).toHaveLength(1);

    await expectGraphQLError(await create("Changed material"), "CONFLICT");

    const [claim] = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "case.create.graphql"),
        ),
      );
    expect(claim?.responseReference).toEqual({ caseId: created.id });

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { caseId: "not-a-uuid" } })
      .where(eq(locationMutationIdempotency.id, claim?.id ?? ""));
    await expectGraphQLError(
      await create("Replay case"),
      "PRECONDITION_FAILED",
    );

    await fixture.database
      .update(locationMutationIdempotency)
      .set({
        responseReference: { caseId: created.id },
        expiresAt: new Date(Date.now() - 1_000),
      })
      .where(eq(locationMutationIdempotency.id, claim?.id ?? ""));
    const takeover = await create("Replay case");
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.createResearchCase.id).not.toBe(created.id);

    const foreign = await fixture.createActor();
    const foreignCreate = await fixture.execute<{
      createResearchCase: { id: string };
    }>({
      jar: foreign.jar,
      operationName: "CreateResearchCase",
      query: CreateResearchCaseDocument,
      variables: {
        title: "Replay case",
        purpose: "research",
        idempotencyKey: "case-create-replay-v1",
      },
    });
    expect(foreignCreate.body?.errors).toBeUndefined();
    expect(foreignCreate.body?.data?.createResearchCase.id).not.toBe(
      created.id,
    );

    const addMember = () =>
      fixture.execute<{
        addCaseMember: {
          id: string;
          principalId: string;
          role: string;
          version: number;
        };
      }>({
        jar: owner.jar,
        operationName: "AddCaseMember",
        query: AddCaseMemberDocument,
        variables: {
          caseId: created.id,
          principalId: member.principalId,
          role: "member",
          idempotencyKey: "case-member-replay-v1",
        },
      });
    const [memberFirst, memberReplay] = await Promise.all([
      addMember(),
      addMember(),
    ]);
    expect(memberFirst.body?.errors).toBeUndefined();
    expect(memberReplay.body?.errors).toBeUndefined();
    expect(memberReplay.body?.data?.addCaseMember).toEqual(
      memberFirst.body?.data?.addCaseMember,
    );
    const members = await fixture.database
      .select({ id: caseMembers.id })
      .from(caseMembers)
      .where(
        and(
          eq(caseMembers.workspaceId, owner.workspaceId),
          eq(caseMembers.caseId, created.id),
          eq(caseMembers.principalId, member.principalId),
        ),
      );
    expect(members).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "case.member.add"),
          ),
        ),
    ).toHaveLength(1);

    const link = () =>
      fixture.execute<{
        linkCaseResource: {
          id: string;
          resourceId: string;
          resourceKind: string;
        };
      }>({
        jar: owner.jar,
        operationName: "LinkCaseResource",
        query: LinkCaseResourceDocument,
        variables: {
          caseId: created.id,
          resourceId: person.id,
          resourceKind: "person",
          explicitConfirmed: true,
          idempotencyKey: "case-link-replay-v1",
          observedAt: "2026-09-12T00:00:00.000Z",
        },
      });
    const [linkFirst, linkReplay] = await Promise.all([link(), link()]);
    expect(linkFirst.body?.errors).toBeUndefined();
    expect(linkReplay.body?.errors).toBeUndefined();
    expect(linkReplay.body?.data?.linkCaseResource).toEqual(
      linkFirst.body?.data?.linkCaseResource,
    );
    const links = await fixture.database
      .select({ id: caseResourceLinks.id })
      .from(caseResourceLinks)
      .where(
        and(
          eq(caseResourceLinks.workspaceId, owner.workspaceId),
          eq(caseResourceLinks.caseId, created.id),
          eq(caseResourceLinks.resourceId, person.id),
        ),
      );
    expect(links).toHaveLength(1);
    expect(
      await fixture.database
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, owner.workspaceId),
            eq(auditEvents.action, "case.resource.link"),
          ),
        ),
    ).toHaveLength(1);
  });
});
