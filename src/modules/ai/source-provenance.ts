import { createHash } from "node:crypto";

/**
 * The hash is deliberately derived only from the captured source material.
 * Provider/model metadata is checked separately so changing providers cannot
 * silently make an old snapshot appear to be a new one.
 */
export function sourceSnapshotHash(input: {
  url: string;
  title: string;
  snippet: string;
  publicationDate?: Date | string | null;
  reliability?: number | string | null;
  metadata?: Record<string, unknown>;
  retrievalHash?: string;
}): string {
  const publicationDate = input.publicationDate
    ? new Date(input.publicationDate).toISOString()
    : null;
  return createHash("sha256")
    .update(
      JSON.stringify({
        publicationDate,
        snippet: input.snippet,
        title: input.title,
        url: input.url,
      }),
      "utf8",
    )
    .digest("hex");
}

export function assertImmutableSourceSnapshot(
  before: {
    url: string;
    title: string;
    snippet: string;
    publicationDate?: Date | string | null;
    retrievalHash: string;
    provider: string;
    model: string;
  },
  after: typeof before,
): void {
  const fields = [
    "url",
    "title",
    "snippet",
    "publicationDate",
    "retrievalHash",
    "provider",
    "model",
  ] as const;
  for (const field of fields) {
    const left =
      field === "publicationDate" && before[field]
        ? new Date(before[field]).toISOString()
        : (before[field] ?? null);
    const right =
      field === "publicationDate" && after[field]
        ? new Date(after[field]).toISOString()
        : (after[field] ?? null);
    if (left !== right)
      throw new Error(
        field === "retrievalHash"
          ? "AI web source snapshot hash cannot change"
          : "AI web source snapshots are immutable",
      );
  }
  if (after.retrievalHash !== sourceSnapshotHash(after))
    throw new Error("AI web source snapshot hash does not match content");
}

export function sourceProviderAgreement(input: {
  runProvider: string;
  runModel: string;
  sourceProvider: string;
  sourceModel: string;
}): boolean {
  return (
    input.runProvider === input.sourceProvider &&
    input.runModel === input.sourceModel
  );
}
