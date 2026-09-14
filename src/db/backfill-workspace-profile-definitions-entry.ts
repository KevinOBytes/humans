import { pathToFileURL } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { newId } from "@/db/id";
import { PROFILE_FACT_DEFINITION_CATALOG_VERSION } from "@/db/profile-fact-definitions";
import * as schema from "@/db/schema";
import {
  backfillWorkspaceProfileDefinitions,
  type WorkspaceProfileDefinitionBackfillResult,
} from "@/modules/auth/workspace-profile-definitions";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function parseWorkspaceProfileDefinitionBackfillArgs(args: string[]): {
  workspaceId: string;
  actorId: string;
} {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  const values = new Map<string, string>();
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const flag = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (
      !flag ||
      !value ||
      !["--workspace-id", "--actor-id"].includes(flag) ||
      values.has(flag)
    ) {
      throw new Error(
        "Usage: operator:backfill-profile-definitions -- --workspace-id <UUID> --actor-id <UUID>",
      );
    }
    values.set(flag, value.trim());
  }
  const workspaceId = values.get("--workspace-id");
  const actorId = values.get("--actor-id");
  if (!workspaceId) throw new Error("--workspace-id is required");
  if (!actorId) throw new Error("--actor-id is required");
  if (!UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(actorId))
    throw new Error("Workspace and actor IDs must be UUIDs");
  return { workspaceId, actorId };
}

export function formatWorkspaceProfileDefinitionBackfillResult(
  result: WorkspaceProfileDefinitionBackfillResult,
): string {
  return JSON.stringify({
    catalogVersion: PROFILE_FACT_DEFINITION_CATALOG_VERSION,
    insertedCount: result.inserted.length,
    insertedKeys: result.inserted.map(
      ({ namespace, fieldKey }) => `${namespace}.${fieldKey}`,
    ),
  });
}

/**
 * Attended, one-workspace-at-a-time historical backfill.
 *
 * The operator supplies a principal from the same workspace. The service
 * validates that scope, serializes the catalog write, and records its audit in
 * the same transaction. No request path invokes this command implicitly.
 */
export async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const input = parseWorkspaceProfileDefinitionBackfillArgs(
    process.argv.slice(2),
  );
  const connection = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const database = drizzle(connection, { schema });
  try {
    const result = await backfillWorkspaceProfileDefinitions(database, {
      ...input,
      requestId: `operator-profile-backfill:${newId()}`,
    });
    process.stdout.write(
      `${formatWorkspaceProfileDefinitionBackfillResult(result)}\n`,
    );
  } finally {
    await connection.end();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (invokedPath === import.meta.url) void main();
