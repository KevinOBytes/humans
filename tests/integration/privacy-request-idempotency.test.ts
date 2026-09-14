// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { files } from "@/db/schema/files";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { auditEvents } from "@/db/schema/operations";
import {
  deletionRequests,
  privacyProcessorPropagations,
  privacyRequests,
} from "@/db/schema/privacy";
import { createPrivacyRequestService } from "@/modules/privacy/request-service";
import { createRetentionService } from "@/modules/privacy/retention-service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";
import {
  CancelPrivacyRequestDocument,
  FulfillPrivacyRequestDocument,
  ReviewPrivacyRequestDocument,
} from "@/graphql/generated/graphql";
import type { SessionActor } from "../support/graphql";

const live = process.env.TEST_DATABASE_URL ? describe : describe.skip;
live("privacy request transition idempotency", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let reviewer: ResearchServiceContext;
  let evidenceId: string;
  let reviewerActor: SessionActor;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    const actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
    reviewerActor = await fixture.createWorkspaceMember(actor, "admin");
    reviewer = await caseContext(fixture, reviewerActor);
    reviewer.actor = {
      ...reviewer.actor,
      role: "admin",
    } as typeof reviewer.actor;
    evidenceId = newId();
    await fixture.database.insert(files).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      storageProvider: "s3",
      storageBucket: "test",
      storageKey: evidenceId,
      originalName: "verification.txt",
      byteSize: 1,
      checksum: "a".repeat(64),
      quarantineState: "available",
      scanState: "clean",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
  });
  afterAll(async () => fixture.close());
  it("exposes only authorized local execution status without the frozen contract or identity manifest", async () => {
    const row = await request("deletion");
    const service = createPrivacyRequestService(reviewer);
    const approved = await service.reviewRequest({
      id: row.id,
      expectedVersion: row.version,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    await service.fulfillRequest({
      id: row.id,
      expectedVersion: approved.version,
    });
    const document = `query LocalExecution($id: UUID!) { privacyLocalExecution(requestId: $id) { state generation resultCode auditReference } }`;
    const result = await fixture.execute({
      query: document,
      variables: { id: row.id },
      jar: reviewerActor.jar,
    });
    expect(result.body?.errors).toBeUndefined();
    expect(result.body?.data).toEqual({
      privacyLocalExecution: {
        state: "pending",
        generation: 0,
        resultCode: null,
        auditReference: null,
      },
    });
    const foreign = await fixture.createActor();
    const denied = await fixture.execute({
      query: document,
      variables: { id: row.id },
      jar: foreign.jar,
    });
    expect(denied.body?.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });
  async function request(requestType = "correction", scoped = context) {
    const person = await coveredPerson(scoped);
    return createPrivacyRequestService(scoped).createRequest({
      requestType,
      personIds: [person.id],
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: newId(),
    });
  }
  async function setup(kind: "review" | "fulfill" | "cancel") {
    const row = await request();
    const service = createPrivacyRequestService(reviewer);
    if (kind === "fulfill")
      await service.reviewRequest({
        id: row.id,
        expectedVersion: 1,
        state: "approved",
        verificationEvidenceId: evidenceId,
      });
    const input = {
      id: row.id,
      expectedVersion: kind === "fulfill" ? 2 : 1,
      idempotencyKey: "transition-key",
    };
    const invoke = (patch = {}, scoped = reviewer) => {
      const target = createPrivacyRequestService(scoped);
      if (kind === "review")
        return target.reviewRequest({
          ...input,
          state: "approved",
          verificationEvidenceId: evidenceId,
          ...patch,
        });
      if (kind === "fulfill")
        return target.fulfillRequest({ ...input, ...patch });
      return target.cancelRequest({ ...input, ...patch });
    };
    return { row, input, invoke };
  }
  async function claim(operation: string) {
    const rows = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, context.workspaceId),
          eq(
            locationMutationIdempotency.operation,
            `privacy.request.${operation}`,
          ),
        ),
      );
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }
  for (const kind of ["review", "fulfill", "cancel"] as const) {
    it(`${kind}: overlapping retries converge with one transition and audit`, async () => {
      const { row, input, invoke } = await setup(kind);
      const [first, second] = await Promise.all([invoke(), invoke()]);
      expect(second).toEqual(first);
      expect(first.version).toBe(input.expectedVersion + 1);
      const stored = await claim(kind);
      expect(stored.responseReference).toEqual({
        privacyRequestId: row.id,
        version: first.version,
        state: first.state,
      });
      const audits = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, row.id),
            eq(
              auditEvents.action,
              `privacy.request.${kind === "review" ? "reviewed" : kind === "cancel" ? "cancelled" : "fulfillment_started"}`,
            ),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain("transition-key");
      if (kind === "fulfill") {
        const rows = await fixture.database
          .select()
          .from(privacyProcessorPropagations)
          .where(eq(privacyProcessorPropagations.privacyRequestId, row.id));
        expect(rows).toHaveLength(5);
      }
    });
    it(`${kind}: changed material and a different principal cannot replay`, async () => {
      const { invoke } = await setup(kind);
      await invoke();
      await expect(invoke({ expectedVersion: 7 })).rejects.toMatchObject({
        extensions: { code: "CONFLICT" },
      });
      await expect(invoke({}, context)).rejects.toMatchObject({
        extensions: { code: "CONFLICT" },
      });
      const foreign = await caseContext(fixture, await fixture.createActor());
      await expect(invoke({}, foreign)).rejects.toMatchObject({
        extensions: { code: "NOT_FOUND" },
      });
    });
    it(`${kind}: malformed or redirected references fail closed`, async () => {
      const { row, invoke } = await setup(kind);
      const result = await invoke();
      const stored = await claim(kind);
      for (const reference of [
        {
          privacyRequestId: "not-a-uuid",
          version: result.version,
          state: result.state,
        },
        {
          privacyRequestId: newId(),
          version: result.version,
          state: result.state,
        },
        {
          privacyRequestId: row.id,
          version: result.version + 1,
          state: result.state,
        },
        {
          privacyRequestId: row.id,
          version: result.version,
          state: "requested",
        },
      ]) {
        await fixture.database
          .update(locationMutationIdempotency)
          .set({ responseReference: reference })
          .where(eq(locationMutationIdempotency.id, stored.id));
        await expect(invoke()).rejects.toMatchObject({
          extensions: { code: "PRECONDITION_FAILED" },
        });
      }
    });
    it(`${kind}: expiry does not repeat a committed stale-version transition`, async () => {
      const { invoke } = await setup(kind);
      await invoke();
      const stored = await claim(kind);
      await fixture.database
        .update(locationMutationIdempotency)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(locationMutationIdempotency.id, stored.id));
      const results = await Promise.allSettled([invoke(), invoke()]);
      expect(
        results.every(
          (r) =>
            r.status === "rejected" && r.reason.extensions.code === "CONFLICT",
        ),
      ).toBe(true);
    });
    it(`${kind}: concurrent expired-claim takeover commits one fresh transition`, async () => {
      const { invoke } = await setup(kind);
      await invoke();
      const stored = await claim(kind);
      const next = await request();
      if (kind === "fulfill")
        await createPrivacyRequestService(reviewer).reviewRequest({
          id: next.id,
          expectedVersion: 1,
          state: "approved",
          verificationEvidenceId: evidenceId,
        });
      await fixture.database
        .update(locationMutationIdempotency)
        .set({
          expiresAt: new Date(Date.now() - 1000),
          status: "pending",
          responseReference: null,
        })
        .where(eq(locationMutationIdempotency.id, stored.id));
      const [first, second] = await Promise.all([
        invoke({ id: next.id }),
        invoke({ id: next.id }),
      ]);
      expect(second).toEqual(first);
      expect(first.id).toBe(next.id);
      expect((await claim(kind)).responseReference).toMatchObject({
        privacyRequestId: next.id,
        version: first.version,
      });
    });
  }
  it("replays never return an older review after a subsequent cancellation", async () => {
    const { row, invoke } = await setup("review");
    await invoke();
    await createPrivacyRequestService(reviewer).cancelRequest({
      id: row.id,
      expectedVersion: 2,
    });
    await expect(invoke()).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
  });
  it("review canonicalization binds state and evidence while accepting UUID casing", async () => {
    const { row, invoke } = await setup("review");
    const first = await invoke();
    expect(
      await invoke({
        id: row.id.toUpperCase(),
        verificationEvidenceId: evidenceId.toUpperCase(),
      }),
    ).toEqual(first);
    await expect(invoke({ state: "rejected" })).rejects.toMatchObject({
      extensions: { code: "CONFLICT" },
    });
    await expect(
      invoke({ verificationEvidenceId: newId() }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
  });
  it("self-approval remains forbidden and failed writes leave no retry claim", async () => {
    const { invoke } = await setup("review");
    await expect(invoke({}, context)).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    const rows = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "privacy.request.review"),
      );
    expect(rows).toHaveLength(0);
  });
  it("replay rechecks current request deletion", async () => {
    const { row, invoke } = await setup("cancel");
    await invoke();
    await fixture.database
      .update(privacyRequests)
      .set({ deletedAt: new Date() })
      .where(eq(privacyRequests.id, row.id));
    await expect(invoke()).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
  });
  it("replay rechecks live session authorization", async () => {
    const { invoke } = await setup("cancel");
    await invoke();
    await fixture.database
      .delete(sessions)
      .where(eq(sessions.userId, reviewer.actor.id));
    await expect(invoke()).rejects.toMatchObject({
      extensions: { code: "FORBIDDEN" },
    });
  });
  it("the same raw key remains isolated between valid workspace principals", async () => {
    const { invoke } = await setup("cancel");
    await invoke();
    const own = await request();
    expect((await invoke({ id: own.id }, context)).id).toBe(own.id);
    const foreign = await caseContext(fixture, await fixture.createActor());
    const foreignRow = await request("access", foreign);
    expect((await invoke({ id: foreignRow.id }, foreign)).id).toBe(
      foreignRow.id,
    );
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        eq(locationMutationIdempotency.operation, "privacy.request.cancel"),
      );
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((r) => r.keyHash)).size).toBe(3);
  });
  it("keyed deletion fulfillment preserves legal holds and creates only one deletion request after release", async () => {
    const row = await request("deletion");
    const service = createPrivacyRequestService(reviewer);
    await service.reviewRequest({
      id: row.id,
      expectedVersion: 1,
      state: "approved",
      verificationEvidenceId: evidenceId,
      idempotencyKey: "approve",
    });
    const hold = await createRetentionService(context).createLegalHold({
      resourceKind: "person",
      resourceId: row.scope.personIds[0]!,
      reason: "Preservation",
      authority: "Independent review",
    });
    const input = {
      id: row.id,
      expectedVersion: 2,
      idempotencyKey: "delete-start",
    };
    await expect(service.fulfillRequest(input)).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    expect(await fixture.database.select().from(deletionRequests)).toHaveLength(
      0,
    );
    await createRetentionService(reviewer).releaseLegalHold({
      id: hold.id,
      expectedVersion: 1,
      reason: "Release",
    });
    const [first, second] = await Promise.all([
      service.fulfillRequest(input),
      service.fulfillRequest(input),
    ]);
    expect(second).toEqual(first);
    expect(await fixture.database.select().from(deletionRequests)).toHaveLength(
      1,
    );
    expect(
      await fixture.database
        .select()
        .from(privacyProcessorPropagations)
        .where(eq(privacyProcessorPropagations.privacyRequestId, row.id)),
    ).toHaveLength(5);
  });
  it("generated GraphQL mutations accept optional keys and replay the complete access lifecycle", async () => {
    const row = await request("access");
    const execute = (
      document: { toString(): string },
      variables: Record<string, unknown>,
    ) =>
      fixture.execute({
        jar: reviewerActor.jar,
        query: document.toString(),
        variables,
      });
    const reviewed = await execute(ReviewPrivacyRequestDocument, {
      id: row.id,
      expectedVersion: 1,
      state: "APPROVED",
      verificationEvidenceId: evidenceId,
      idempotencyKey: "graphql-review",
    });
    expect(reviewed.body?.errors).toBeUndefined();
    expect(reviewed.body?.data).toMatchObject({
      reviewPrivacyRequest: { id: row.id, version: 2 },
    });
    expect(
      (
        await execute(ReviewPrivacyRequestDocument, {
          id: row.id,
          expectedVersion: 1,
          state: "APPROVED",
          verificationEvidenceId: evidenceId,
          idempotencyKey: "graphql-review",
        })
      ).body,
    ).toEqual(reviewed.body);
    const started = await execute(FulfillPrivacyRequestDocument, {
      id: row.id,
      expectedVersion: 2,
      idempotencyKey: "graphql-start",
    });
    expect(started.body?.errors).toBeUndefined();
    expect(started.body?.data).toMatchObject({
      fulfillPrivacyRequest: { id: row.id, version: 3 },
    });
    const completed = await execute(FulfillPrivacyRequestDocument, {
      id: row.id,
      expectedVersion: 3,
      completionEvidenceId: evidenceId,
      idempotencyKey: "graphql-complete",
    });
    expect(completed.body?.errors).toBeUndefined();
    expect(completed.body?.data).toMatchObject({
      fulfillPrivacyRequest: { id: row.id, version: 4 },
    });
    expect(
      (
        await execute(FulfillPrivacyRequestDocument, {
          id: row.id,
          expectedVersion: 3,
          completionEvidenceId: evidenceId,
          idempotencyKey: "graphql-complete",
        })
      ).body,
    ).toEqual(completed.body);
    const another = await request("access");
    const cancelled = await execute(CancelPrivacyRequestDocument, {
      id: another.id,
      expectedVersion: 1,
      idempotencyKey: "graphql-cancel",
    });
    expect(cancelled.body?.errors).toBeUndefined();
    expect(cancelled.body?.data).toMatchObject({
      cancelPrivacyRequest: { id: another.id, version: 2 },
    });
    expect(
      (
        await execute(CancelPrivacyRequestDocument, {
          id: another.id,
          expectedVersion: 1,
          idempotencyKey: "graphql-cancel",
        })
      ).body,
    ).toEqual(cancelled.body);
  });
});
