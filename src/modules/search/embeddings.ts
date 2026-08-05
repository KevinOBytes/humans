import { and, desc, eq } from "drizzle-orm";

import { newId } from "@/db/id";
import { embeddings } from "@/db/schema/search";
import type { Database } from "@/modules/auth/bootstrap-admin";

const MAX_DIMENSIONS = 4096;

export type EmbeddingProvider = {
  provider: string;
  model: string;
  dimensions: number;
  embed(text: string): Promise<readonly number[]>;
};

export function validateEmbedding(
  value: readonly number[],
  dimensions: number,
): number[] {
  if (
    !Number.isSafeInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > MAX_DIMENSIONS ||
    value.length !== dimensions ||
    value.some((item) => !Number.isFinite(item))
  ) {
    throw new TypeError("Embedding dimensions or values are invalid");
  }
  return [...value];
}

function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! ** 2;
    rightMagnitude += right[index]! ** 2;
  }
  return leftMagnitude === 0 || rightMagnitude === 0
    ? 0
    : dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

export function createEmbeddingService(database: Database) {
  return {
    async upsert(input: {
      workspaceId: string;
      resourceKind: string;
      resourceId: string;
      sourceHash: string;
      configuration?: Record<string, unknown>;
      provider: EmbeddingProvider;
      text: string;
    }) {
      const vector = validateEmbedding(
        await input.provider.embed(input.text),
        input.provider.dimensions,
      );
      const [row] = await database
        .insert(embeddings)
        .values({
          id: newId(),
          workspaceId: input.workspaceId,
          resourceKind: input.resourceKind,
          resourceId: input.resourceId,
          provider: input.provider.provider,
          model: input.provider.model,
          dimensions: input.provider.dimensions,
          vectorJson: vector,
          sourceHash: input.sourceHash,
          configuration: input.configuration ?? {},
        })
        .onConflictDoUpdate({
          target: [
            embeddings.workspaceId,
            embeddings.resourceKind,
            embeddings.resourceId,
            embeddings.provider,
            embeddings.model,
            embeddings.sourceHash,
          ],
          set: {
            vectorJson: vector,
            dimensions: input.provider.dimensions,
            configuration: input.configuration ?? {},
            generatedAt: new Date(),
          },
        })
        .returning();
      if (!row) throw new Error("Embedding upsert did not return a row");
      return row;
    },
    async nearest(input: {
      workspaceId: string;
      resourceKind?: string;
      provider: string;
      model: string;
      vector: readonly number[];
      limit?: number;
    }) {
      const vector = validateEmbedding(input.vector, input.vector.length);
      const rows = await database
        .select()
        .from(embeddings)
        .where(
          and(
            eq(embeddings.workspaceId, input.workspaceId),
            eq(embeddings.provider, input.provider),
            eq(embeddings.model, input.model),
            input.resourceKind
              ? eq(embeddings.resourceKind, input.resourceKind)
              : undefined,
          ),
        )
        .orderBy(desc(embeddings.generatedAt));
      return rows
        .filter(
          (row) =>
            row.dimensions === vector.length && Array.isArray(row.vectorJson),
        )
        .map((row) => ({
          row,
          score: cosineSimilarity(vector, row.vectorJson as number[]),
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.row.id.localeCompare(right.row.id),
        )
        .slice(0, Math.min(100, Math.max(1, input.limit ?? 20)));
    },
  };
}
