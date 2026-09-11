// @vitest-environment node
import { beforeAll, beforeEach, afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { people } from "@/db/schema/people";
import { createRetentionService } from "@/modules/privacy/retention-service";
import type { ResearchServiceContext } from "@/modules/audit/service";
import { ResearchFixture } from "../support/research-fixture";
import { caseContext, coveredPerson } from "../support/cases";
const live = process.env.TEST_DATABASE_URL ? describe : describe.skip;
live("retention legal hold boundary", () => {
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
