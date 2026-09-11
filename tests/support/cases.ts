import { eq } from "drizzle-orm";
import { newId } from "@/db/id";
import { sessions } from "@/db/schema/auth";
import { people } from "@/db/schema/people";
import { rolePermissionKeys } from "@/modules/auth/permissions";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { createGovernanceService } from "@/modules/governance/service";
import { disabledSearchIndexMaintenance } from "@/modules/search/index-maintenance";
import type { SessionActor } from "./graphql";
import type { ResearchFixture } from "./research-fixture";

export async function caseContext(
  fixture: Pick<ResearchFixture, "database">,
  actor: SessionActor,
): Promise<ResearchServiceContext> {
  const [session] = await fixture.database
    .select()
    .from(sessions)
    .where(eq(sessions.userId, actor.userId))
    .limit(1);
  return {
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
    permissions: new Set(rolePermissionKeys("owner")),
    searchIndexMaintenance: disabledSearchIndexMaintenance,
    idempotencyHmacKey: "ab".repeat(32),
  };
}
export async function coveredPerson(
  context: ResearchServiceContext,
  options: { policy?: boolean; sensitivity?: "internal" | "restricted" } = {},
) {
  const id = newId();
  await context.database.insert(people).values({
    id,
    workspaceId: context.workspaceId,
    displayName: "Case fixture person",
    sensitivity: options.sensitivity ?? "internal",
    createdBy: context.actor.principalId,
    updatedBy: context.actor.principalId,
  });
  const governance = createGovernanceService(context);
  if (options.policy !== false)
    await governance.createPurposePolicy({
      purpose: "research",
      lawfulBases: ["consent"],
      effectiveFrom: new Date(Date.now() - 60_000),
      state: "active",
    });
  const consent = await governance.recordConsent({
    personId: id,
    purpose: "research",
    scopes: ["read", "write"],
    lawfulBasis: "consent",
    effectiveFrom: new Date(Date.now() - 60_000),
  });
  return { id, consentId: consent.id };
}
