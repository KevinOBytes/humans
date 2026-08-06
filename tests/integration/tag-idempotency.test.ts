// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { auditEvents } from "@/db/schema/operations";
import { locationMutationIdempotency } from "@/db/schema/locations";
import { personTags } from "@/db/schema/evidence";

import { expectGraphQLError } from "../support/graphql";
import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

function required<T>(value: T | null | undefined, label: string): T {
  if (value == null) throw new Error(`Missing ${label}`);
  return value;
}

liveDescribe("tag mutation idempotency", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(async () => fixture.reset());
  afterAll(async () => fixture.close());

  it("replays createTag, fences malformed/expired references, and isolates workspaces", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const query = /* GraphQL */ `
      mutation CreateTag($input: CreateTagInput!) {
        createTag(input: $input) {
          tag {
            id
            name
            normalizedName
          }
          issues {
            code
          }
          code
        }
      }
    `;
    const input = {
      idempotencyKey: "tag-create-replay-v1",
      name: "Research priority",
      color: "#aabbcc",
    };
    const create = (
      actor: typeof owner,
      variables: Omit<typeof input, "idempotencyKey"> & {
        idempotencyKey?: string | null;
      },
    ) =>
      fixture.execute<{
        createTag: {
          code: string | null;
          issues: Array<{ code: string }>;
          tag: { id: string; name: string; normalizedName: string } | null;
        };
      }>({
        jar: actor.jar,
        operationName: "CreateTag",
        query,
        variables: { input: variables },
      });

    const [first, replay] = await Promise.all([
      create(owner, input),
      create(owner, input),
    ]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstTag = required(first.body?.data?.createTag.tag, "first tag");
    expect(replay.body?.data?.createTag.tag?.id).toBe(firstTag.id);

    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "tag.create.graphql"),
        ),
      );
    expect(claims).toHaveLength(1);
    const claim = required(claims[0], "tag claim");
    expect(claim.responseReference).toEqual({ tagId: firstTag.id });
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "tag.create"),
        ),
      );
    expect(audits).toHaveLength(1);

    const duplicate = await create(owner, { ...input, idempotencyKey: null });
    expect(duplicate.body?.errors).toBeUndefined();
    expect(duplicate.body?.data?.createTag).toMatchObject({
      code: "CONFLICT",
      tag: null,
    });

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { tagId: "not-a-uuid" } })
      .where(eq(locationMutationIdempotency.id, claim.id));
    expectGraphQLError(await create(owner, input), "PRECONDITION_FAILED");

    const expiryInput = {
      ...input,
      idempotencyKey: "tag-create-expiry-v1",
      name: "Expiry tag",
    };
    const beforeExpiry = await create(owner, expiryInput);
    const beforeExpiryId = required(
      beforeExpiry.body?.data?.createTag.tag?.id,
      "pre-expiry tag",
    );
    const expiryClaim = required(
      (
        await fixture.database
          .select()
          .from(locationMutationIdempotency)
          .where(
            and(
              eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
              eq(locationMutationIdempotency.operation, "tag.create.graphql"),
            ),
          )
      ).find(
        (row) =>
          (row.responseReference as { tagId?: unknown } | null)?.tagId ===
          beforeExpiryId,
      ),
      "expiry claim",
    );
    await fixture.database
      .update(locationMutationIdempotency)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(locationMutationIdempotency.id, expiryClaim.id));
    const takeover = await create(owner, expiryInput);
    expect(takeover.body?.errors).toBeUndefined();
    expect(takeover.body?.data?.createTag).toMatchObject({
      code: "CONFLICT",
      tag: null,
    });
    const takeoverClaims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "tag.create.graphql"),
        ),
      );
    expect(takeoverClaims).toHaveLength(2);
    expect(takeoverClaims.map((row) => row.id)).not.toContain(expiryClaim.id);

    const foreignResult = await create(foreign, input);
    const foreignTagId = required(
      foreignResult.body?.data?.createTag.tag?.id,
      "foreign tag",
    );
    expect(foreignTagId).not.toBe(firstTag.id);
  });

  it("replays concurrent tagPerson calls without duplicate associations or audits", async () => {
    const owner = await fixture.createActor();
    const foreign = await fixture.createActor();
    const person = await fixture.createPerson(owner, {
      displayName: "Tagged person",
    });
    const personId = required(
      person.body?.data?.createPerson?.person?.id,
      "person",
    );
    const tagResult = await fixture.execute<{
      createTag: { tag: { id: string } | null };
    }>({
      jar: owner.jar,
      operationName: "CreateTag",
      query: /* GraphQL */ `
        mutation CreateTag($input: CreateTagInput!) {
          createTag(input: $input) {
            tag {
              id
            }
          }
        }
      `,
      variables: { input: { name: "Identity tag" } },
    });
    const tagId = required(tagResult.body?.data?.createTag.tag?.id, "tag");
    const query = /* GraphQL */ `
      mutation TagPerson($input: TagPersonInput!) {
        tagPerson(input: $input) {
          personTag {
            id
            personId
            tagId
          }
          issues {
            code
          }
          code
        }
      }
    `;
    const input = { personId, tagId, idempotencyKey: "tag-person-replay-v1" };
    const tag = () =>
      fixture.execute<{
        tagPerson: { code: string | null; personTag: { id: string } | null };
      }>({
        jar: owner.jar,
        operationName: "TagPerson",
        query,
        variables: { input },
      });
    const [first, replay] = await Promise.all([tag(), tag()]);
    expect(first.body?.errors).toBeUndefined();
    expect(replay.body?.errors).toBeUndefined();
    const firstLink = required(
      first.body?.data?.tagPerson.personTag,
      "person tag",
    );
    expect(replay.body?.data?.tagPerson.personTag?.id).toBe(firstLink.id);

    const rows = await fixture.database
      .select()
      .from(personTags)
      .where(
        and(
          eq(personTags.workspaceId, owner.workspaceId),
          eq(personTags.personId, personId),
          eq(personTags.tagId, tagId),
        ),
      );
    expect(rows).toHaveLength(1);
    const claims = await fixture.database
      .select()
      .from(locationMutationIdempotency)
      .where(
        and(
          eq(locationMutationIdempotency.workspaceId, owner.workspaceId),
          eq(locationMutationIdempotency.operation, "tag.person.graphql"),
        ),
      );
    expect(claims).toHaveLength(1);
    expect(claims[0]?.responseReference).toEqual({ personTagId: firstLink.id });
    const audits = await fixture.database
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, owner.workspaceId),
          eq(auditEvents.action, "tag.person"),
        ),
      );
    expect(audits).toHaveLength(1);

    await fixture.database
      .update(locationMutationIdempotency)
      .set({ responseReference: { personTagId: "not-a-uuid" } })
      .where(eq(locationMutationIdempotency.id, claims[0]?.id ?? ""));
    expectGraphQLError(await tag(), "PRECONDITION_FAILED");

    const foreignPerson = await fixture.createPerson(foreign, {
      displayName: "Foreign tagged person",
    });
    const foreignPersonId = required(
      foreignPerson.body?.data?.createPerson?.person?.id,
      "foreign person",
    );
    const foreignTagResult = await fixture.execute<{
      createTag: { tag: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "CreateTag",
      query: /* GraphQL */ `
        mutation CreateTag($input: CreateTagInput!) {
          createTag(input: $input) {
            tag {
              id
            }
          }
        }
      `,
      variables: { input: { name: "Foreign identity tag" } },
    });
    const foreignTagId = required(
      foreignTagResult.body?.data?.createTag.tag?.id,
      "foreign tag",
    );
    const foreignTagged = await fixture.execute<{
      tagPerson: { code: string | null; personTag: { id: string } | null };
    }>({
      jar: foreign.jar,
      operationName: "TagPerson",
      query,
      variables: {
        input: {
          idempotencyKey: input.idempotencyKey,
          personId: foreignPersonId,
          tagId: foreignTagId,
        },
      },
    });
    expect(foreignTagged.body?.errors).toBeUndefined();
    const foreignLink = required(
      foreignTagged.body?.data?.tagPerson.personTag,
      "foreign person tag",
    );
    expect(foreignLink.id).not.toBe(firstLink.id);
  });
});
