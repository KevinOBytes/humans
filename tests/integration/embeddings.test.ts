// @vitest-environment node

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { newId } from "@/db/id";
import { embeddings } from "@/db/schema/search";
import { createEmbeddingService } from "@/modules/search/embeddings";

import { ResearchFixture } from "../support/research-fixture";

const liveDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

liveDescribe("provider-neutral embeddings", () => {
  let fixture: ResearchFixture;

  beforeAll(() => {
    fixture = new ResearchFixture();
  });
  beforeEach(() => fixture.reset());
  afterAll(() => fixture.close());

  it("persists metadata, upserts by source hash, ranks by cosine, and scopes by workspace", async () => {
    const actor = await fixture.createActor("owner");
    const otherActor = await fixture.createActor("owner");
    const service = createEmbeddingService(fixture.database);
    const provider = {
      provider: "fixture",
      model: "fixture-2d",
      dimensions: 2,
      embed: async () => [1, 0] as const,
    };
    const resourceId = newId();
    const sourceHash = `sha256:${"ab".repeat(32)}`;

    const first = await service.upsert({
      configuration: { revision: 1, redacted: true },
      provider,
      resourceId,
      resourceKind: "person",
      sourceHash,
      text: "Ada Lovelace",
      workspaceId: actor.workspaceId,
    });
    const second = await service.upsert({
      configuration: { revision: 2, redacted: true },
      provider,
      resourceId,
      resourceKind: "person",
      sourceHash,
      text: "Ada Lovelace updated",
      workspaceId: actor.workspaceId,
    });

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      dimensions: 2,
      model: "fixture-2d",
      provider: "fixture",
      sourceHash,
      vectorJson: [1, 0],
    });
    expect(second.configuration).toEqual({ revision: 2, redacted: true });

    await service.upsert({
      provider,
      resourceId: newId(),
      resourceKind: "person",
      sourceHash: `sha256:${"cd".repeat(32)}`,
      text: "Grace Hopper",
      workspaceId: actor.workspaceId,
    });
    const nearest = await service.nearest({
      limit: 10,
      model: "fixture-2d",
      provider: "fixture",
      vector: [1, 0],
      workspaceId: actor.workspaceId,
    });
    expect(nearest).toHaveLength(2);
    expect(nearest[0]?.score).toBeCloseTo(1);
    expect(nearest[0]?.row.id).toBe(first.id);

    const stored = await fixture.database
      .select()
      .from(embeddings)
      .where(
        and(
          eq(embeddings.workspaceId, actor.workspaceId),
          eq(embeddings.resourceId, resourceId),
        ),
      );
    expect(stored).toHaveLength(1);
    await expect(
      service.nearest({
        model: "fixture-2d",
        provider: "fixture",
        vector: [1, 0],
        workspaceId: otherActor.workspaceId,
      }),
    ).resolves.toEqual([]);
  });
});
