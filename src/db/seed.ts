import { pathToFileURL } from "node:url";

import postgres from "postgres";

import { assertDatabaseSeedAllowed } from "./seed-guard";

const fixtures = [
  {
    memberId: "seed-member-alpha",
    organizationId: "seed-organization-alpha",
    organizationName: "Research Alpha",
    organizationSlug: "seed-research-alpha",
    personId: "01900000-0000-7000-8000-000000000011",
    principalId: "01900000-0000-7000-8000-000000000003",
    userEmail: "seed-alpha@localhost.invalid",
    userId: "seed-user-alpha",
    workspaceId: "01900000-0000-7000-8000-000000000001",
    workspaceName: "Alpha Workspace",
  },
  {
    memberId: "seed-member-beta",
    organizationId: "seed-organization-beta",
    organizationName: "Research Beta",
    organizationSlug: "seed-research-beta",
    personId: "01900000-0000-7000-8000-000000000012",
    principalId: "01900000-0000-7000-8000-000000000004",
    userEmail: "seed-beta@localhost.invalid",
    userId: "seed-user-beta",
    workspaceId: "01900000-0000-7000-8000-000000000002",
    workspaceName: "Beta Workspace",
  },
] as const;

export async function seedDatabase(databaseUrl: string): Promise<void> {
  assertDatabaseSeedAllowed({
    allowSeed: process.env.ALLOW_DATABASE_SEED,
    databaseUrl,
    nodeEnv: process.env.NODE_ENV,
  });

  const connection = postgres(databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });

  try {
    await connection.begin(async (sql) => {
      for (const fixture of fixtures) {
        await sql`
          INSERT INTO users (id, name, email, email_verified, created_at, updated_at)
          VALUES (${fixture.userId}, ${fixture.organizationName}, ${fixture.userEmail}, true, now(), now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            email = EXCLUDED.email,
            email_verified = EXCLUDED.email_verified,
            updated_at = EXCLUDED.updated_at
        `;
        await sql`
          INSERT INTO organizations (id, name, slug, created_at)
          VALUES (${fixture.organizationId}, ${fixture.organizationName}, ${fixture.organizationSlug}, now())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            slug = EXCLUDED.slug
        `;
        await sql`
          INSERT INTO workspaces (id, organization_id, name, created_by, updated_by)
          VALUES (${fixture.workspaceId}, ${fixture.organizationId}, ${fixture.workspaceName}, ${fixture.userId}, ${fixture.userId})
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
        `;
        await sql`
          INSERT INTO members (id, organization_id, user_id, role, created_at, workspace_id)
          VALUES (${fixture.memberId}, ${fixture.organizationId}, ${fixture.userId}, 'owner', now(), ${fixture.workspaceId})
          ON CONFLICT (id) DO UPDATE SET
            role = EXCLUDED.role,
            workspace_id = EXCLUDED.workspace_id
        `;
        await sql`
          INSERT INTO workspace_principals (
            id,
            workspace_id,
            principal_type,
            user_id,
            member_id_snapshot
          ) VALUES (
            ${fixture.principalId},
            ${fixture.workspaceId},
            'user',
            ${fixture.userId},
            ${fixture.memberId}
          )
          ON CONFLICT (workspace_id, user_id) DO NOTHING
        `;
        await sql`
          INSERT INTO people (id, workspace_id, display_name, sort_name, created_by, updated_by)
          VALUES (${fixture.personId}, ${fixture.workspaceId}, 'Ada Lovelace', 'Lovelace, Ada', ${fixture.userId}, ${fixture.userId})
          ON CONFLICT (id) DO UPDATE SET
            display_name = EXCLUDED.display_name,
            sort_name = EXCLUDED.sort_name,
            updated_at = now(),
            updated_by = EXCLUDED.updated_by
        `;
      }
    });
  } finally {
    await connection.end();
  }
}

export async function main(): Promise<void> {
  await seedDatabase(process.env.DATABASE_URL ?? "");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main();
}
