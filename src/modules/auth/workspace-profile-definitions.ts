import { and, eq, isNull, sql } from "drizzle-orm";

import { newId } from "@/db/id";
import {
  createDefaultProfileFactDefinitions,
  PROFILE_FACT_DEFINITION_CATALOG_VERSION,
} from "@/db/profile-fact-definitions";
import { factDefinitions } from "@/db/schema/facts";
import { auditEvents } from "@/db/schema/operations";
import { workspacePrincipals } from "@/db/schema/principals";
import { workspaces } from "@/db/schema/workspaces";
import type { Database } from "@/modules/auth/bootstrap-admin";

export type WorkspaceProfileDefinitionBackfillResult = {
  inserted: readonly {
    id: string;
    namespace: string;
    fieldKey: string;
    version: number;
  }[];
};

type BackfillInput = {
  workspaceId: string;
  actorId: string;
  requestId: string;
};

async function backfillWithinTransaction(
  database: Database,
  input: BackfillInput,
): Promise<WorkspaceProfileDefinitionBackfillResult> {
  await database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId}, 61412))`,
  );
  const [workspace] = await database
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.id, input.workspaceId), isNull(workspaces.deletedAt)),
    )
    .limit(1);
  if (!workspace) throw new Error("Profile backfill workspace does not exist");

  const [actor] = await database
    .select({
      apiKeyId: workspacePrincipals.apiKeyId,
      id: workspacePrincipals.id,
      userId: workspacePrincipals.userId,
    })
    .from(workspacePrincipals)
    .where(
      and(
        eq(workspacePrincipals.workspaceId, input.workspaceId),
        eq(workspacePrincipals.id, input.actorId),
      ),
    )
    .limit(1);
  if (!actor)
    throw new Error("Profile backfill requires a workspace principal");

  const inserted = await database
    .insert(factDefinitions)
    .values(
      createDefaultProfileFactDefinitions({
        workspaceId: input.workspaceId,
        actorId: actor.id,
      }),
    )
    .onConflictDoNothing()
    .returning({
      id: factDefinitions.id,
      namespace: factDefinitions.namespace,
      fieldKey: factDefinitions.fieldKey,
      version: factDefinitions.version,
    });

  if (inserted.length > 0) {
    await database.insert(auditEvents).values({
      id: newId(),
      workspaceId: input.workspaceId,
      actorUserId: actor.userId,
      apiKeyId: actor.apiKeyId,
      action: "factDefinition.catalogBackfill",
      resourceKind: "factDefinitionCatalog",
      requestId: input.requestId,
      redactedDiff: {
        changedFields: ["definitions"],
        metadata: {
          catalogVersion: PROFILE_FACT_DEFINITION_CATALOG_VERSION,
          insertedCount: inserted.length,
        },
      },
      outcome: "success",
    });
  }

  return { inserted };
}

export async function backfillWorkspaceProfileDefinitions(
  database: Database,
  input: BackfillInput,
): Promise<WorkspaceProfileDefinitionBackfillResult> {
  const requestId = input.requestId.trim();
  if (!requestId || requestId.length > 200)
    throw new Error("Profile backfill requires a valid request ID");
  return database.transaction((transaction) =>
    backfillWithinTransaction(transaction as unknown as Database, {
      ...input,
      requestId,
    }),
  );
}

export async function provisionWorkspaceProfileDefinitions(
  database: Database,
  input: BackfillInput,
): Promise<WorkspaceProfileDefinitionBackfillResult> {
  return backfillWithinTransaction(database, input);
}
