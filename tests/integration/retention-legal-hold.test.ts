// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { files } from "@/db/schema/files";
import { people } from "@/db/schema/people";
import { auditEvents } from "@/db/schema/operations";
import { privacyRequests } from "@/db/schema/privacy";
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
});
