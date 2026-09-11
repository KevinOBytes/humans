// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { factDefinitions } from "@/db/schema/facts";
import { accessApprovals } from "@/db/schema/governance";
import { auditEvents } from "@/db/schema/operations";
import { people } from "@/db/schema/people";
import { accessPolicies, resourceGrants } from "@/db/schema/workspaces";
import { createFactsService } from "@/modules/facts/service";
import { createGovernanceService } from "@/modules/governance/service";
import { checkPurposeCoverage } from "@/modules/governance/coverage";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import { ResearchFixture } from "../support/research-fixture";
import type { SessionActor } from "../support/graphql";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;
liveDescribe(
  "governance PostgreSQL lifecycle (requires disposable TEST_DATABASE_URL)",
  () => {
    let fixture: ResearchFixture;
    let actor: SessionActor;
    let context: ResearchServiceContext;
    let personId: string;
    let definitionId: string;
    let policyId: string;
    let consentId: string;
    const secret = "ab".repeat(32);
    beforeAll(() => {
      fixture = new ResearchFixture();
    });
    beforeEach(async () => {
      await fixture.reset();
      actor = await fixture.createActor();
      const [session] = await fixture.database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, actor.userId))
        .limit(1);
      context = {
        database: fixture.database,
        workspaceId: actor.workspaceId,
        requestId: newId(),
        actor: {
          type: "user",
          id: actor.userId,
          principalId: actor.principalId,
          memberId: actor.memberId,
          sessionId: session!.id,
          role: "owner",
        },
        permissions: new Set([
          "workspace:read",
          "workspace:update",
          "person:read",
          "fact:read",
          "fact:create",
          "fact:update",
        ]),
        searchIndexMaintenance: disabledSearchIndexMaintenance,
        idempotencyHmacKey: secret,
      };
      personId = newId();
      definitionId = newId();
      await fixture.database.insert(people).values({
        id: personId,
        workspaceId: actor.workspaceId,
        displayName: "Governed subject",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      await fixture.database.insert(factDefinitions).values({
        id: definitionId,
        workspaceId: actor.workspaceId,
        namespace: "research",
        fieldKey: "finding",
        label: "Finding",
        allowedValueType: "text",
        defaultSensitivity: "public",
        state: "active",
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      const governance = createGovernanceService(context);
      const policy = await governance.createPurposePolicy({
        idempotencyKey: newId(),
        purpose: "research",
        lawfulBases: ["consent"],
        effectiveFrom: "2026-01-01T00:00:00Z",
        state: "active",
      });
      policyId = policy.id;
      await governance.setFieldPolicy({
        idempotencyKey: newId(),
        purposePolicyId: policyId,
        fieldDefinitionId: definitionId,
        permittedScopes: ["write", "restricted_read"],
        sensitivityCeiling: "restricted",
      });
      consentId = (
        await governance.recordConsent({
          idempotencyKey: newId(),
          personId,
          purpose: "research",
          scopes: ["write", "restricted_read", "ai_operation"],
          lawfulBasis: "consent",
          effectiveFrom: "2026-01-01T00:00:00Z",
        })
      ).id;
    });
    afterAll(async () => {
      await fixture.close();
    });

    async function restrictedFact() {
      const result = await createFactsService(context).create({
        personId,
        definitionId,
        sensitivity: "restricted",
        value: { text: "Protected value" },
        governancePurpose: "research",
      });
      const fact = result.resource!;
      expect(fact).toBeTruthy();
      const accessPolicyId = newId();
      await fixture.database.insert(accessPolicies).values({
        id: accessPolicyId,
        workspaceId: actor.workspaceId,
        name: `Access ${newId()}`,
        state: "active",
        sensitivityCeiling: "restricted",
        resourceKinds: ["fact"],
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      await fixture.database.insert(resourceGrants).values({
        id: newId(),
        workspaceId: actor.workspaceId,
        policyId: accessPolicyId,
        memberId: actor.memberId,
        resourceKind: "fact",
        resourceId: fact.id,
        createdBy: actor.principalId,
        updatedBy: actor.principalId,
      });
      return fact;
    }

    it("requires coverage during a sensitivity downgrade and preserves it in idempotent revisions", async () => {
      const fact = await restrictedFact();
      const service = createFactsService(context, {
        idempotencyHmacKey: secret,
      });
      await expect(
        service.revise({
          id: fact.id,
          expectedVersion: 1,
          sensitivity: "public",
          value: { text: "Changed" },
        }),
      ).rejects.toThrow("governed purpose");
      const input = {
        id: fact.id,
        expectedVersion: 1,
        sensitivity: "internal",
        value: { text: "Changed" },
        governancePurpose: "research",
        governanceCaseReference: "case-1",
        idempotencyKey: newId(),
      };
      const revised = await service.reviseIdempotent(input);
      expect(revised.resource).toMatchObject({
        version: 2,
        valueText: "Changed",
      });
      expect((await service.reviseIdempotent(input)).resource?.id).toBe(
        fact.id,
      );
      await expect(
        service.reviseIdempotent({
          ...input,
          governanceCaseReference: "case-2",
        }),
      ).rejects.toThrow();
    });

    it("binds governance context into idempotent creates", async () => {
      const service = createFactsService(context, {
        idempotencyHmacKey: secret,
      });
      const input = {
        personId,
        definitionId,
        value: { text: "Finding" },
        governancePurpose: " Research ",
        governanceCaseReference: "case-1",
        idempotencyKey: newId(),
      };
      const first = await service.createIdempotent(input);
      expect(first.resource).toBeTruthy();
      expect((await service.createIdempotent(input)).resource?.id).toBe(
        first.resource!.id,
      );
      await expect(
        service.createIdempotent({ ...input, governancePurpose: "other" }),
      ).rejects.toThrow();
    });

    it("uses the newest field policy and the actual row sensitivity rather than the definition default", async () => {
      await createGovernanceService(context).setFieldPolicy({
        idempotencyKey: newId(),
        purposePolicyId: policyId,
        fieldDefinitionId: definitionId,
        permittedScopes: ["write"],
        sensitivityCeiling: "internal",
      });
      await expect(
        createFactsService(context).create({
          personId,
          definitionId,
          value: { text: "Protected" },
          sensitivity: "restricted",
          governancePurpose: "research",
        }),
      ).rejects.toThrow("Consent coverage");
    });

    it("requires approved principal-specific reads, records audit, and immediately honors withdrawal", async () => {
      const fact = await restrictedFact();
      const service = createFactsService(context);
      const governance = createGovernanceService(context);
      expect(await service.get(fact.id)).toBeNull();
      const approval = await governance.requestApproval({
        idempotencyKey: newId(),
        personId,
        fieldDefinitionId: definitionId,
        purpose: "research",
        reason: "Documented need",
      });
      expect(await service.get(fact.id)).toBeNull();
      await expect(
        governance.reviewApproval({
          idempotencyKey: newId(),
          id: approval.id,
          expectedVersion: 1,
          state: "approved",
          reason: "Self approval must be rejected",
        }),
      ).rejects.toThrow("could not be reviewed");
      const reviewer = await fixture.createWorkspaceMember(actor, "admin");
      const [reviewerSession] = await fixture.database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, reviewer.userId))
        .limit(1);
      const reviewerContext: ResearchServiceContext = {
        ...context,
        actor: {
          type: "user",
          id: reviewer.userId,
          principalId: reviewer.principalId,
          memberId: reviewer.memberId,
          sessionId: reviewerSession!.id,
          role: "admin",
        },
      };
      await createGovernanceService(reviewerContext).reviewApproval({
        idempotencyKey: newId(),
        id: approval.id,
        expectedVersion: 1,
        state: "approved",
        reason: "Approved need",
      });
      expect((await service.get(fact.id))?.valueText).toBe("Protected value");
      const audits = await fixture.database
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, actor.workspaceId),
            eq(auditEvents.action, "governance.restricted_read"),
          ),
        );
      expect(audits.length).toBeGreaterThan(0);
      await governance.withdrawConsent({
        idempotencyKey: newId(),
        id: consentId,
        expectedVersion: 1,
      });
      expect(await service.get(fact.id)).toBeNull();
      expect(
        (
          await checkPurposeCoverage(context, {
            personId,
            purpose: "research",
            scope: "write",
          })
        ).reason,
      ).toBe("withdrawn");
    });

    it("does not disclose consent coverage for a restricted or cross-workspace person", async () => {
      const governance = createGovernanceService(context);
      await fixture.database
        .update(people)
        .set({ sensitivity: "restricted" })
        .where(eq(people.id, personId));

      expect(
        await governance.getCoverage({
          personId,
          purpose: "research",
          scope: "write",
        }),
      ).toEqual({
        allowed: false,
        reason: "missing_consent",
        consentRecordId: null,
        policyId: null,
      });

      const foreign = await fixture.createActor();
      const [foreignSession] = await fixture.database
        .select()
        .from(sessions)
        .where(eq(sessions.userId, foreign.userId))
        .limit(1);
      expect(
        await createGovernanceService({
          ...context,
          workspaceId: foreign.workspaceId,
          actor: {
            type: "user",
            id: foreign.userId,
            principalId: foreign.principalId,
            memberId: foreign.memberId,
            sessionId: foreignSession!.id,
            role: "owner",
          },
        }).getCoverage({
          personId,
          purpose: "research",
          scope: "write",
        }),
      ).toEqual({
        allowed: false,
        reason: "missing_consent",
        consentRecordId: null,
        policyId: null,
      });
    });

    it("does not expand API-key base visibility, and rejects expired or cross-workspace approvals", async () => {
      const fact = await restrictedFact();
      const key = await fixture.provisionKey(actor, {
        person: ["read"],
        fact: ["read"],
      });
      const result = await fixture.execute({
        apiKey: key.key,
        query: `query($id: UUID!) { fact(id: $id) { id value { text } } }`,
        variables: { id: fact.id },
      });
      expect(result.body?.errors).toBeUndefined();
      expect(result.body?.data?.fact).toBeNull();
      const governance = createGovernanceService(context);
      const approval = await governance.requestApproval({
        idempotencyKey: newId(),
        personId,
        fieldDefinitionId: definitionId,
        purpose: "research",
        reason: "Documented need",
      });
      await governance.reviewApproval({
        idempotencyKey: newId(),
        id: approval.id,
        expectedVersion: 1,
        state: "approved",
        reason: "Approved",
      });
      await fixture.database
        .update(accessApprovals)
        .set({ expiresAt: new Date(0) })
        .where(eq(accessApprovals.id, approval.id));
      expect(await createFactsService(context).get(fact.id)).toBeNull();
      const foreign = await fixture.createActor();
      expect(
        (
          await checkPurposeCoverage(
            { database: fixture.database, workspaceId: foreign.workspaceId },
            { personId, purpose: "research", scope: "write" },
          )
        ).allowed,
      ).toBe(false);
    });
  },
);
