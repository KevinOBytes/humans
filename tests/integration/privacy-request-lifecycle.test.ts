// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import {
  consentRecords,
  privacyProcessorPropagations,
} from "@/db/schema/privacy";
import { createPrivacyRequestService } from "@/modules/privacy/request-service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";

const live = process.env.TEST_DATABASE_URL ? describe : describe.skip;
live("privacy request lifecycle", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let reviewer: ResearchServiceContext;
  let evidenceId: string;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    const actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
    const second = await fixture.createWorkspaceMember(actor, "admin");
    reviewer = await caseContext(fixture, second);
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
  it("binds replay material, blocks self-approval and requires completion evidence", async () => {
    const person = await coveredPerson(context);
    const service = createPrivacyRequestService(context);
    const input = {
      requestType: "access",
      personIds: [person.id],
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "access-1",
    };
    const request = await service.createRequest(input);
    expect((await service.createRequest(input)).id).toBe(request.id);
    await expect(
      service.createRequest({ ...input, requestType: "correction" }),
    ).rejects.toMatchObject({ extensions: { code: "CONFLICT" } });
    await expect(
      service.reviewRequest({
        id: request.id,
        expectedVersion: 1,
        state: "approved",
        verificationEvidenceId: evidenceId,
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    const review = createPrivacyRequestService(reviewer);
    const approved = await review.reviewRequest({
      id: request.id,
      expectedVersion: 1,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    const fulfilling = await review.fulfillRequest({
      id: request.id,
      expectedVersion: approved.version,
    });
    expect(fulfilling.state).toBe("fulfilling");
    expect(
      (
        await review.fulfillRequest({
          id: request.id,
          expectedVersion: fulfilling.version,
          completionEvidenceId: evidenceId,
        })
      ).state,
    ).toBe("completed");
  });
  it("does not disclose foreign resources or requests", async () => {
    const person = await coveredPerson(context);
    const row = await createPrivacyRequestService(context).createRequest({
      requestType: "deletion",
      personIds: [person.id],
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "delete-1",
    });
    const other = createPrivacyRequestService(
      await caseContext(fixture, await fixture.createActor()),
    );
    await expect(other.getRequest(row.id)).rejects.toMatchObject({
      extensions: { code: "NOT_FOUND" },
    });
    await expect(
      other.createRequest({
        requestType: "access",
        personIds: [person.id],
        dueAt: new Date(Date.now() + 86_400_000),
        idempotencyKey: "access-1",
      }),
    ).rejects.toMatchObject({ extensions: { code: "NOT_FOUND" } });
  });
  it("withdraws matching consent atomically and leaves processors pending", async () => {
    const person = await coveredPerson(context);
    const request = await createPrivacyRequestService(context).createRequest({
      requestType: "consent_withdrawal",
      personIds: [person.id],
      purpose: "research",
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: "withdraw-1",
    });
    const service = createPrivacyRequestService(reviewer);
    const approved = await service.reviewRequest({
      id: request.id,
      expectedVersion: 1,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    await service.fulfillRequest({
      id: request.id,
      expectedVersion: approved.version,
    });
    const [consent] = await fixture.database
      .select()
      .from(consentRecords)
      .where(eq(consentRecords.id, person.consentId));
    expect(consent?.status).toBe("withdrawn");
    const outcomes = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.privacyRequestId, request.id));
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((r) => r.state === "pending")).toBe(true);
  });
});
