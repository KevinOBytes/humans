const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type ReindexCommand = Readonly<{
  batchSize: number;
  dryRun: boolean;
  workspaceId: string;
}>;

export function parseReindexCommand(argv: readonly string[]): ReindexCommand {
  let workspaceId: string | null = null;
  let batchSize = 100;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      if (dryRun) throw new TypeError("--dry-run may be supplied only once.");
      dryRun = true;
      continue;
    }
    if (argument !== "--workspace" && argument !== "--batch-size")
      throw new TypeError("Unknown search reindex argument.");
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new TypeError(`${argument} requires a value.`);
    index += 1;
    if (argument === "--workspace") {
      if (workspaceId !== null || !UUID.test(value))
        throw new TypeError("A valid unique workspace UUID is required.");
      workspaceId = value.toLowerCase();
    } else {
      if (!/^[1-9][0-9]*$/u.test(value))
        throw new TypeError("The batch size must be between 1 and 500.");
      batchSize = Number(value);
      if (batchSize > 500)
        throw new TypeError("The batch size must be between 1 and 500.");
    }
  }
  if (!workspaceId) throw new TypeError("--workspace is required.");
  return Object.freeze({ batchSize, dryRun, workspaceId });
}
