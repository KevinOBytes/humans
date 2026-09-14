// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { auditEvents, jobs } from "@/db/schema/operations";
import {
  consentRecords,
  deletionRequests,
  privacyRequests,
  privacyProcessorPropagations,
} from "@/db/schema/privacy";
import { people } from "@/db/schema/people";
import { retentionPolicies } from "@/db/schema/workspaces";
import { executeApprovedDeletionRequests } from "@/modules/privacy/deletion-executor";
import { createPrivacyRequestService } from "@/modules/privacy/request-service";
import {
  createCachePrivacyProcessorAdapter,
  executePrivacyPropagations,
} from "@/modules/privacy/propagation-worker";
import { createRetentionService } from "@/modules/privacy/retention-service";
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
  async function startDeletion(personIds: string[], fileIds: string[] = []) {
    const request = await createPrivacyRequestService(context).createRequest({
      requestType: "deletion",
      personIds,
      fileIds,
      dueAt: new Date(Date.now() + 86_400_000),
      idempotencyKey: newId(),
    });
    const service = createPrivacyRequestService(reviewer);
    const approved = await service.reviewRequest({
      id: request.id,
      expectedVersion: request.version,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    return service.fulfillRequest({
      id: request.id,
      expectedVersion: approved.version,
    });
  }
  const execute = () =>
    executeApprovedDeletionRequests({
      database: fixture.database,
      encryptionKey: "ab".repeat(32),
    });

  it("rejects an approved deletion queue row without its canonical request and processors", async () => {
    const person = await coveredPerson(context);
    const rawRequestId = newId();
    await fixture.database.insert(deletionRequests).values({
      id: rawRequestId,
      workspaceId: context.workspaceId,
      requesterId: context.actor.principalId,
      scope: { personIds: [person.id], fileIds: [] },
      state: "approved",
      reviewedAt: new Date(),
      reviewedBy: context.actor.principalId,
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });

    expect(await execute()).toBe(0);
    const [rawRequest] = await fixture.database
      .select({
        reviewNotes: deletionRequests.reviewNotes,
        state: deletionRequests.state,
      })
      .from(deletionRequests)
      .where(eq(deletionRequests.id, rawRequestId));
    expect(rawRequest).toEqual({
      reviewNotes: "Deletion requires a governed privacy request.",
      state: "rejected",
    });
    const [subject] = await fixture.database
      .select({ deletedAt: people.deletedAt })
      .from(people)
      .where(eq(people.id, person.id));
    expect(subject?.deletedAt).toBeNull();
    expect(
      await fixture.database
        .select()
        .from(privacyProcessorPropagations)
        .where(
          eq(privacyProcessorPropagations.workspaceId, context.workspaceId),
        ),
    ).toHaveLength(0);
    const audits = await fixture.database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, rawRequestId),
          eq(auditEvents.action, "deletion_request.rejected"),
        ),
      );
    expect(audits).toEqual([
      { redactedDiff: { reason: "missing_governance_parent" } },
    ]);
  });

  it("rejects a governed deletion queue row when processor governance is incomplete", async () => {
    const person = await coveredPerson(context);
    const request = await startDeletion([person.id]);
    await fixture.database
      .delete(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.privacyRequestId, request.id));

    expect(await execute()).toBe(0);
    const [rawRequest] = await fixture.database
      .select({
        reviewNotes: deletionRequests.reviewNotes,
        state: deletionRequests.state,
      })
      .from(deletionRequests)
      .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
    expect(rawRequest).toEqual({
      reviewNotes: "Deletion requires configured processor governance.",
      state: "rejected",
    });
    const [governed] = await fixture.database
      .select({ state: privacyRequests.state })
      .from(privacyRequests)
      .where(eq(privacyRequests.id, request.id));
    expect(governed?.state).toBe("rejected");
    const [subject] = await fixture.database
      .select({ deletedAt: people.deletedAt })
      .from(people)
      .where(eq(people.id, person.id));
    expect(subject?.deletedAt).toBeNull();
    const audits = await fixture.database
      .select({ redactedDiff: auditEvents.redactedDiff })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, request.legacyDeletionRequestId!),
          eq(auditEvents.action, "deletion_request.rejected"),
        ),
      );
    expect(audits).toEqual([
      { redactedDiff: { reason: "missing_processor_governance" } },
    ]);
  });

  it("does not let rejected requests starve the default processor batch or discard their history", async () => {
    const person = await coveredPerson(context);
    const policyId = newId();
    await fixture.database.insert(retentionPolicies).values({
      id: policyId,
      workspaceId: context.workspaceId,
      resourceKind: "person",
      retentionDays: 0,
      deletionBehavior: "hard_delete",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });
    const rejectedIds: string[] = [];
    for (let index = 0; index < 5; index++) {
      rejectedIds.push((await startDeletion([person.id])).id);
    }
    expect(await execute()).toBe(0);
    await fixture.database
      .update(privacyProcessorPropagations)
      .set({ nextAttemptAt: new Date(0) })
      .where(
        inArray(privacyProcessorPropagations.privacyRequestId, rejectedIds),
      );
    const rejectedRequests = await fixture.database
      .select()
      .from(privacyRequests)
      .where(inArray(privacyRequests.id, rejectedIds));
    expect(rejectedRequests.every((row) => row.state === "rejected")).toBe(
      true,
    );
    const rejectedProcessors = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(
        inArray(privacyProcessorPropagations.privacyRequestId, rejectedIds),
      );
    expect(rejectedProcessors).toHaveLength(25);
    const rejectedAuditIds = rejectedRequests.map((row) => row.auditReference!);
    const rejectedAudits = await fixture.database
      .select()
      .from(auditEvents)
      .where(inArray(auditEvents.id, rejectedAuditIds));
    expect(rejectedAudits).toHaveLength(5);

    await fixture.database
      .update(retentionPolicies)
      .set({ deletionBehavior: "soft_delete", version: 2 })
      .where(eq(retentionPolicies.id, policyId));
    const valid = await startDeletion([person.id]);
    expect(await execute()).toBe(1);
    expect(
      await executePrivacyPropagations({
        database: fixture.database,
        now: new Date(Date.now() + 1_000),
        adapters: { cache: createCachePrivacyProcessorAdapter() },
      }),
    ).toBe(5);
    const validProcessors = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.privacyRequestId, valid.id));
    expect(validProcessors.every((row) => row.attempts === 1)).toBe(true);
    expect(
      validProcessors.find((row) => row.processor === "cache"),
    ).toMatchObject({
      state: "not_applicable",
      evidenceReference: "cache:not-applicable:operational-only",
    });
    expect(
      await fixture.database
        .select()
        .from(privacyProcessorPropagations)
        .where(
          inArray(privacyProcessorPropagations.privacyRequestId, rejectedIds),
        ),
    ).toEqual(rejectedProcessors);
    expect(
      await fixture.database
        .select()
        .from(privacyRequests)
        .where(inArray(privacyRequests.id, rejectedIds)),
    ).toEqual(rejectedRequests);
    expect(
      await fixture.database
        .select()
        .from(auditEvents)
        .where(inArray(auditEvents.id, rejectedAuditIds)),
    ).toEqual(rejectedAudits);
  });

  it.each(["invalid", "substituted", "unavailable", "foreign"] as const)(
    "atomically rejects a %s governed scope and replays without extra effects",
    async (kind) => {
      const person = await coveredPerson(context);
      const sibling = await coveredPerson(context);
      const request = await startDeletion([person.id]);
      if (kind === "unavailable") {
        await fixture.database
          .update(people)
          .set({ deletedAt: new Date() })
          .where(eq(people.id, person.id));
      } else if (kind === "foreign") {
        const other = await caseContext(fixture, await fixture.createActor());
        const foreign = await coveredPerson(other);
        const scope = { personIds: [foreign.id], fileIds: [] };
        // Even mutually consistent queue snapshots cannot authorize a foreign
        // resource: the worker must independently enforce workspace predicates.
        await fixture.database
          .update(privacyRequests)
          .set({ scope })
          .where(eq(privacyRequests.id, request.id));
        await fixture.database
          .update(deletionRequests)
          .set({ scope })
          .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
      } else {
        await fixture.database
          .update(deletionRequests)
          .set({
            scope:
              kind === "invalid"
                ? { personIds: ["not-a-uuid"], fileIds: [] }
                : { personIds: [sibling.id], fileIds: [] },
          })
          .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
      }
      const before = await fixture.database.select().from(people);
      expect(await Promise.all([execute(), execute()])).toEqual([0, 0]);
      const [terminal] = await fixture.database
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.id, request.id));
      expect(terminal).toMatchObject({
        state: "rejected",
        version: request.version + 1,
      });
      const [legacy] = await fixture.database
        .select()
        .from(deletionRequests)
        .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
      expect(legacy?.state).toBe("rejected");
      expect(await fixture.database.select().from(people)).toEqual(before);
      const audits = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.resourceId, request.legacyDeletionRequestId!),
            eq(auditEvents.action, "deletion_request.rejected"),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(terminal?.auditReference).toBe(audits[0]?.id);
      expect(audits[0]?.redactedDiff).toEqual({
        reason:
          kind === "invalid"
            ? "invalid_scope"
            : kind === "substituted"
              ? "governed_scope_mismatch"
              : "scope_unavailable",
      });
      expect(await execute()).toBe(0);
      expect(
        await fixture.database
          .select()
          .from(privacyRequests)
          .where(eq(privacyRequests.id, request.id)),
      ).toEqual([terminal]);
      expect(
        await fixture.database
          .select()
          .from(consentRecords)
          .where(eq(consentRecords.id, person.consentId)),
      ).toHaveLength(1);
    },
  );

  it("rolls back terminal rejection if its immutable audit cannot commit", async () => {
    const person = await coveredPerson(context);
    const request = await startDeletion([person.id]);
    await fixture.database
      .update(deletionRequests)
      .set({ scope: {} })
      .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
    await fixture.database
      .execute(sql`create function fail_privacy_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'deletion_request.rejected' then raise exception 'fixture audit unavailable'; end if;
        return new;
      end;
    $$`);
    await fixture.database
      .execute(sql`create trigger fail_privacy_audit before insert on audit_events
      for each row execute function fail_privacy_audit()`);
    await expect(execute()).rejects.toThrow();
    const [governed] = await fixture.database
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, request.id));
    const [legacy] = await fixture.database
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.id, request.legacyDeletionRequestId!));
    expect(governed).toEqual(request);
    expect(legacy).toMatchObject({ state: "approved", version: 1 });
    await fixture.database.execute(
      sql`drop trigger fail_privacy_audit on audit_events`,
    );
    expect(await execute()).toBe(0);
    expect(
      (
        await fixture.database
          .select()
          .from(privacyRequests)
          .where(eq(privacyRequests.id, request.id))
      )[0]?.state,
    ).toBe("rejected");
  });
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
  it("rolls back resource mutation when completion audit fails and recovers exactly once", async () => {
    const person = await coveredPerson(context);
    const request = await startDeletion([person.id]);
    const before = await fixture.database.select().from(people);
    const consentBefore = await fixture.database.select().from(consentRecords);
    await fixture.database
      .execute(sql`create function fail_completion_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'deletion_request.completed' then raise exception 'fixture audit unavailable'; end if;
        return new;
      end;
    $$`);
    await fixture.database
      .execute(sql`create trigger fail_completion_audit before insert on audit_events
      for each row execute function fail_completion_audit()`);
    await expect(execute()).rejects.toThrow();
    expect(await fixture.database.select().from(people)).toEqual(before);
    expect(await fixture.database.select().from(consentRecords)).toEqual(
      consentBefore,
    );
    expect(
      (
        await fixture.database
          .select()
          .from(deletionRequests)
          .where(eq(deletionRequests.id, request.legacyDeletionRequestId!))
      )[0],
    ).toMatchObject({ state: "approved", version: 1, completedAt: null });
    await fixture.database.execute(
      sql`drop trigger fail_completion_audit on audit_events`,
    );
    const results = await Promise.all([execute(), execute()]);
    expect(results.sort()).toEqual([0, 1]);
    expect(await execute()).toBe(0);
    const [archived] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, person.id));
    expect(archived).toMatchObject({
      status: "archived",
      version: 2,
    });
    expect(archived?.deletedAt).toBeInstanceOf(Date);
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, request.legacyDeletionRequestId!),
          eq(auditEvents.action, "deletion_request.completed"),
        ),
      );
    expect(audits).toHaveLength(1);
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
  it.each(["hard_delete", "anonymize"] as const)(
    "surfaces governed person %s as a durable rejection",
    async (deletionBehavior) => {
      const person = await coveredPerson(context);
      await fixture.database.insert(retentionPolicies).values({
        id: newId(),
        workspaceId: context.workspaceId,
        resourceKind: "person",
        retentionDays: 0,
        deletionBehavior,
        createdBy: context.actor.principalId,
        updatedBy: context.actor.principalId,
      });
      const service = createPrivacyRequestService(context);
      const request = await service.createRequest({
        requestType: "deletion",
        personIds: [person.id],
        purpose: "subject deletion",
        dueAt: new Date(Date.now() + 86_400_000),
        idempotencyKey: "unsupported-retention-action",
      });
      const approved = await createPrivacyRequestService(
        reviewer,
      ).reviewRequest({
        id: request.id,
        expectedVersion: request.version,
        state: "approved",
        verificationEvidenceId: evidenceId,
      });
      const fulfilling = await createPrivacyRequestService(
        reviewer,
      ).fulfillRequest({
        id: approved.id,
        expectedVersion: approved.version,
      });
      expect(fulfilling.state).toBe("fulfilling");

      expect(
        await executeApprovedDeletionRequests({
          database: fixture.database,
          encryptionKey: "ab".repeat(32),
          now: new Date(),
        }),
      ).toBe(0);

      const rejected = await createPrivacyRequestService(reviewer).getRequest(
        request.id,
      );
      expect(rejected).toMatchObject({
        auditReference: expect.any(String),
        state: "rejected",
        version: fulfilling.version + 1,
      });
      const [unchanged] = await fixture.database
        .select({ deletedAt: people.deletedAt, status: people.status })
        .from(people)
        .where(eq(people.id, person.id));
      expect(unchanged).toEqual({ deletedAt: null, status: "active" });
      const [audit] = await fixture.database
        .select({ redactedDiff: auditEvents.redactedDiff })
        .from(auditEvents)
        .where(eq(auditEvents.id, rejected.auditReference!));
      expect(audit?.redactedDiff).toEqual({
        deletionBehavior,
        reason: "retention_action_unsupported",
      });
      expect(JSON.stringify(audit)).not.toContain(person.id);
    },
  );
  it.each(["hard_delete", "anonymize"] as const)(
    "rejects file %s without deleting verification/provenance or scheduling cleanup",
    async (deletionBehavior) => {
      await fixture.database.insert(retentionPolicies).values({
        id: newId(),
        workspaceId: context.workspaceId,
        resourceKind: "file",
        retentionDays: 0,
        deletionBehavior,
        createdBy: context.actor.principalId,
        updatedBy: context.actor.principalId,
      });
      const request = await startDeletion([], [evidenceId]);
      const before = await fixture.database.select().from(files);
      const beforeJobs = await fixture.database.select().from(jobs);
      expect(await Promise.all([execute(), execute()])).toEqual([0, 0]);
      expect(await fixture.database.select().from(files)).toEqual(before);
      expect(await fixture.database.select().from(jobs)).toEqual(beforeJobs);
      const terminal = await createPrivacyRequestService(reviewer).getRequest(
        request.id,
      );
      expect(terminal).toMatchObject({
        state: "rejected",
        verificationEvidenceId: evidenceId,
      });
      const [audit] = await fixture.database
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.id, terminal.auditReference!));
      expect(audit?.redactedDiff).toEqual({
        deletionBehavior,
        reason: "retention_action_unsupported",
      });
      expect(
        await executePrivacyPropagations({ database: fixture.database }),
      ).toBe(0);
      const processors = await fixture.database
        .select()
        .from(privacyProcessorPropagations)
        .where(eq(privacyProcessorPropagations.privacyRequestId, request.id));
      expect(processors).toHaveLength(5);
      expect(
        processors.every(
          (row) => row.state === "pending" && row.attempts === 0,
        ),
      ).toBe(true);
    },
  );
  it("keeps a newly held approved request retryable without destructive effects", async () => {
    const person = await coveredPerson(context);
    const request = await startDeletion([person.id]);
    await createRetentionService(context).createLegalHold({
      resourceKind: "person",
      resourceId: person.id,
      reason: "Preserve fixture",
      authority: "Independent review",
    });
    const before = await fixture.database.select().from(people);
    expect(await execute()).toBe(0);
    expect(await execute()).toBe(0);
    expect(await fixture.database.select().from(people)).toEqual(before);
    expect(
      (await createPrivacyRequestService(reviewer).getRequest(request.id))
        .state,
    ).toBe("fulfilling");
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, request.legacyDeletionRequestId!),
          eq(auditEvents.action, "deletion_request.blocked"),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.redactedDiff).toEqual({ reason: "active_legal_hold" });
  });
  it("retries processor failure without repeating local destructive effects", async () => {
    const person = await coveredPerson(context);
    const request = await startDeletion([person.id]);
    expect(await execute()).toBe(1);
    const before = await fixture.database.select().from(people);
    const now = new Date(Date.now() + 1_000);
    await executePrivacyPropagations({
      database: fixture.database,
      now,
      adapters: {
        email: async () => {
          throw new Error("external fixture failure");
        },
      },
    });
    const [failed] = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(
        and(
          eq(privacyProcessorPropagations.privacyRequestId, request.id),
          eq(privacyProcessorPropagations.processor, "email"),
        ),
      );
    expect(failed).toMatchObject({
      state: "failed",
      attempts: 1,
      resultCode: "processor_failed",
    });
    expect(await execute()).toBe(0);
    await executePrivacyPropagations({
      database: fixture.database,
      now: new Date(now.getTime() + 60_001),
      adapters: {
        email: async () => ({
          state: "succeeded",
          evidenceReference: "fixture:email-erasure",
        }),
      },
    });
    expect(await fixture.database.select().from(people)).toEqual(before);
    const [succeeded] = await fixture.database
      .select()
      .from(privacyProcessorPropagations)
      .where(eq(privacyProcessorPropagations.id, failed!.id));
    expect(succeeded).toMatchObject({ state: "succeeded", attempts: 2 });
    expect(
      (await createPrivacyRequestService(reviewer).getRequest(request.id))
        .state,
    ).toBe("fulfilling");
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.resourceId, request.legacyDeletionRequestId!),
          eq(auditEvents.action, "deletion_request.completed"),
        ),
      );
    expect(audits).toHaveLength(1);
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
