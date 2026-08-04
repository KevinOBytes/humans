import "server-only";

import { databaseConnection, db } from "@/db/client";
import {
  createSearchIndexMaintenance,
  reindexWorkspace,
} from "@/modules/search/indexer";
import {
  createTask12Metrics,
  disabledMetricsSink,
} from "@/modules/search/metrics";
import { parseReindexCommand } from "@/modules/search/reindex-command";

async function main() {
  const command = parseReindexCommand(process.argv.slice(2));
  const result = await reindexWorkspace({
    ...command,
    database: db,
    maintenance: createSearchIndexMaintenance({
      metrics: createTask12Metrics(disabledMetricsSink),
    }),
  });
  process.stdout.write(
    `${JSON.stringify({
      batchSize: command.batchSize,
      dryRun: command.dryRun,
      processed: result.processed,
      upserted: result.upserted,
      workspaceId: command.workspaceId,
    })}\n`,
  );
}

async function run() {
  try {
    await main();
  } finally {
    await databaseConnection.end({ timeout: 5 });
  }
}

void run().catch(() => {
  process.stderr.write("Search reindex failed.\n");
  process.exitCode = 1;
});
