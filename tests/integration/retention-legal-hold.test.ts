// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { people } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import { deletionRequests, privacyRequests } from "@/db/schema/privacy";
import { executeApprovedDeletionRequests } from "@/modules/privacy/deletion-executor";
import { createPrivacyRequestService } from "@/modules/privacy/request-service";
import { retentionPolicies } from "@/db/schema/workspaces";
import { createRetentionService } from "@/modules/privacy/retention-service";
import { enqueueExpiredRetentionRequests } from "@/modules/privacy/retention-worker";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";
import { caseContext, coveredPerson } from "../support/cases";
const live = process.env.TEST_DATABASE_URL ? describe : describe.skip;
live("retention legal hold boundary", () => {
  let fixture: ResearchFixture;
  let context: ResearchServiceContext;
  let actor: SessionActor;
  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => {
    await fixture.reset();
    actor = await fixture.createActor();
    context = await caseContext(fixture, actor);
  });
  afterAll(async () => fixture.close());
  it.each(["person", "file"] as const)(
    "held %s records cannot starve the bounded retention review queue",
    async (resourceKind) => {
      const now = new Date("2026-09-12T00:00:00Z");
      const heldId = newId();
      const eligibleId = newId();
      const laterId = newId();
      const policyId = newId();
      for (const [index, id] of [heldId, eligibleId, laterId].entries()) {
        const common = {
          id,
          workspaceId: context.workspaceId,
          createdAt: new Date(Date.UTC(2026, 7, index + 1)),
          createdBy: context.actor.principalId,
          updatedBy: context.actor.principalId,
        };
        if (resourceKind === "person")
          await fixture.database.insert(people).values({
            ...common,
            displayName: "Private retention fixture",
          });
        else
          await fixture.database.insert(files).values({
            ...common,
            storageProvider: "s3",
            storageBucket: "private-fixture",
            storageKey: id,
            originalName: "private-retention-fixture.txt",
            byteSize: 1,
            checksum: "a".repeat(64),
            uploadedBy: context.actor.id,
          });
      }
      await fixture.database.insert(retentionPolicies).values({
        id: policyId,
        workspaceId: context.workspaceId,
        resourceKind,
        retentionDays: 30,
        deletionBehavior: "soft_delete",
        createdBy: context.actor.principalId,
        updatedBy: context.actor.principalId,
      });
      const hold = await createRetentionService(context).createLegalHold({
        resourceKind,
        resourceId: heldId,
        reason: "Private preservation reason",
        authority: "Private authority",
      });
      const run = () =>
        enqueueExpiredRetentionRequests({
          database: fixture.database,
          idempotencyHmacKey: "ab".repeat(32),
          limit: 1,
          now,
        });

      expect(await run()).toBe(1);
      const [first] = await fixture.database.select().from(privacyRequests);
      expect(first).toMatchObject({
        state: "requested",
        requesterId: "worker:retention",
        purpose: `retention:${policyId}:v1`,
        scope:
          resourceKind === "person"
            ? { personIds: [eligibleId], fileIds: [] }
            : { personIds: [], fileIds: [eligibleId] },
        verifiedAt: null,
        reviewedBy: null,
        legacyDeletionRequestId: null,
      });
      expect(await run()).toBe(1);
      expect(await run()).toBe(0);
      const requests = await fixture.database.select().from(privacyRequests);
      expect(requests).toHaveLength(2);
      expect(requests.every((row) => row.state === "requested")).toBe(true);
      expect(JSON.stringify(requests.map((row) => row.scope))).not.toContain(
        heldId,
      );
      const reviewer = await caseContext(
        fixture,
        await fixture.createWorkspaceMember(actor, "admin"),
      );
      reviewer.actor = {
        ...reviewer.actor,
        role: "admin",
      } as typeof reviewer.actor;
      await createRetentionService(reviewer).releaseLegalHold({
        id: hold.id,
        expectedVersion: 1,
        reason: "Independent release after preservation review",
      });
      expect(await run()).toBe(1);
      expect(await run()).toBe(0);
      const [releasedRequest] = await fixture.database
        .select()
        .from(privacyRequests)
        .where(
          and(
            eq(privacyRequests.workspaceId, context.workspaceId),
            eq(
              privacyRequests.scope,
              resourceKind === "person"
                ? { personIds: [heldId], fileIds: [] }
                : { personIds: [], fileIds: [heldId] },
            ),
          ),
        );
      expect(releasedRequest?.state).toBe("requested");
      const table = resourceKind === "person" ? people : files;
      const resources = await fixture.database
        .select({ deletedAt: table.deletedAt, version: table.version })
        .from(table)
        .where(eq(table.workspaceId, context.workspaceId));
      expect(resources).toEqual([
        { deletedAt: null, version: 1 },
        { deletedAt: null, version: 1 },
        { deletedAt: null, version: 1 },
      ]);
      const audits = await fixture.database
        .select({ redactedDiff: auditEvents.redactedDiff })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, context.workspaceId),
            eq(auditEvents.action, "privacy.retention.candidate_queued"),
          ),
        );
      expect(audits).toEqual(
        Array.from({ length: 3 }, () => ({
          redactedDiff: {
            deletionBehavior: "soft_delete",
            policyId,
            reason: "retention_elapsed_soft_delete_requires_approval",
            resourceKind,
          },
        })),
      );
    },
  );
  it("a legal hold blocks evaluation and cannot be self-released", async () => {
    const person = await coveredPerson(context);
    const service = createRetentionService(context);
    const resource = { resourceKind: "person" as const, resourceId: person.id };
    const hold = await service.createLegalHold({
      ...resource,
      reason: "Preservation",
      authority: "Reviewer decision",
    });
    expect(hold.auditReference).toBeTruthy();
    expect((await service.evaluateRetention(resource)).state).toBe(
      "blocked_by_legal_hold",
    );
    await expect(
      service.releaseLegalHold({
        id: hold.id,
        expectedVersion: 1,
        reason: "Release",
      }),
    ).rejects.toMatchObject({ extensions: { code: "PRECONDITION_FAILED" } });
    expect(await service.listLegalHolds(resource)).toHaveLength(1);
    const [row] = await fixture.database
      .select()
      .from(people)
      .where(eq(people.id, person.id));
    expect(row?.deletedAt).toBeNull();
  });

  it("fulfills queued retention requests only while the policy version remains current", async () => {
    const now = new Date("2026-09-12T00:00:00Z");
    const executablePersonId = newId();
    const blockedPersonId = newId();
    const unfulfilledPersonId = newId();
    const policyId = newId();
    await fixture.database.insert(people).values(
      [executablePersonId, blockedPersonId, unfulfilledPersonId].map((id) => ({
        id,
        workspaceId: context.workspaceId,
        displayName: "Private retention fixture",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        createdBy: context.actor.principalId,
        updatedBy: context.actor.principalId,
      })),
    );
    await fixture.database.insert(retentionPolicies).values({
      id: policyId,
      workspaceId: context.workspaceId,
      resourceKind: "person",
      retentionDays: 30,
      deletionBehavior: "soft_delete",
      createdBy: context.actor.principalId,
      updatedBy: context.actor.principalId,
    });

    expect(
      await enqueueExpiredRetentionRequests({
        database: fixture.database,
        idempotencyHmacKey: "ab".repeat(32),
        now,
      }),
    ).toBe(3);
    const requests = await fixture.database
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.workspaceId, context.workspaceId));
    expect(requests).toHaveLength(3);
    const executableRequest = requests.find((row) =>
      row.scope.personIds.includes(executablePersonId),
    );
    const blockedRequest = requests.find((row) =>
      row.scope.personIds.includes(blockedPersonId),
    );
    const unfulfilledRequest = requests.find((row) =>
      row.scope.personIds.includes(unfulfilledPersonId),
    );
    for (const request of requests)
      expect(request).toMatchObject({
        purpose: `retention:${policyId}:v1`,
        requesterId: "worker:retention",
        state: "requested",
      });

    const evidenceId = newId();
    await fixture.database.insert(files).values({
      id: evidenceId,
      workspaceId: context.workspaceId,
      storageProvider: "s3",
      storageBucket: "private-fixture",
      storageKey: evidenceId,
      originalName: "private-retention-review.txt",
      byteSize: 1,
      checksum: "b".repeat(64),
      quarantineState: "available",
      scanState: "clean",
      uploadedBy: actor.userId,
      createdBy: actor.principalId,
      updatedBy: actor.principalId,
    });
    const reviewer = await caseContext(
      fixture,
      await fixture.createWorkspaceMember(actor, "admin"),
    );
    reviewer.actor = {
      ...reviewer.actor,
      role: "admin",
    } as typeof reviewer.actor;
    const service = createPrivacyRequestService(reviewer);
    const approvedExecutable = await service.reviewRequest({
      id: executableRequest!.id,
      expectedVersion: executableRequest!.version,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    expect(
      (
        await service.fulfillRequest({
          id: approvedExecutable.id,
          expectedVersion: approvedExecutable.version,
        })
      ).state,
    ).toBe("fulfilling");
    expect(
      await executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "ab".repeat(32),
        now,
      }),
    ).toBe(1);
    const approvedBlocked = await service.reviewRequest({
      id: blockedRequest!.id,
      expectedVersion: blockedRequest!.version,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });
    expect(
      (
        await service.fulfillRequest({
          id: approvedBlocked.id,
          expectedVersion: approvedBlocked.version,
        })
      ).state,
    ).toBe("fulfilling");
    const approvedUnfulfilled = await service.reviewRequest({
      id: unfulfilledRequest!.id,
      expectedVersion: unfulfilledRequest!.version,
      state: "approved",
      verificationEvidenceId: evidenceId,
    });

    await fixture.database
      .update(retentionPolicies)
      .set({
        deletionBehavior: "review",
        updatedBy: reviewer.actor.principalId,
        version: 2,
      })
      .where(eq(retentionPolicies.id, policyId));

    expect(
      await executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "ab".repeat(32),
        now,
      }),
    ).toBe(0);
    const [blockedDeletion] = await fixture.database
      .select()
      .from(deletionRequests)
      .where(eq(deletionRequests.state, "approved"));
    expect(blockedDeletion).toMatchObject({
      reviewNotes: "Deletion requires the current retention policy.",
      state: "approved",
    });
    expect(
      await executeApprovedDeletionRequests({
        database: fixture.database,
        encryptionKey: "ab".repeat(32),
        now,
      }),
    ).toBe(0);
    const policyBlocks = await fixture.database
      .select({
        outcome: auditEvents.outcome,
        redactedDiff: auditEvents.redactedDiff,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, context.workspaceId),
          eq(auditEvents.action, "deletion_request.blocked"),
        ),
      );
    expect(policyBlocks).toEqual([
      {
        outcome: "failure",
        redactedDiff: { reason: "retention_policy_changed" },
      },
    ]);

    await expect(
      service.fulfillRequest({
        id: approvedUnfulfilled.id,
        expectedVersion: approvedUnfulfilled.version,
      }),
    ).rejects.toMatchObject({
      extensions: { code: "PRECONDITION_FAILED" },
    });
    const requestsForDeletion = await fixture.database
      .select()
      .from(deletionRequests);
    expect(requestsForDeletion).toHaveLength(2);
    expect(requestsForDeletion).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: { personIds: [executablePersonId], fileIds: [] },
          state: "completed",
        }),
        expect.objectContaining({
          scope: { personIds: [blockedPersonId], fileIds: [] },
          state: "approved",
        }),
      ]),
    );
    expect(blockedDeletion?.scope).toEqual({
      personIds: [blockedPersonId],
      fileIds: [],
    });
    const resources = await fixture.database
      .select({
        deletedAt: people.deletedAt,
        id: people.id,
        version: people.version,
      })
      .from(people);
    expect(resources).toEqual(
      expect.arrayContaining([
        {
          deletedAt: expect.any(Date),
          id: executablePersonId,
          version: 2,
        },
        { deletedAt: null, id: blockedPersonId, version: 1 },
        { deletedAt: null, id: unfulfilledPersonId, version: 1 },
      ]),
    );
  });
});
