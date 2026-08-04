import { randomUUID } from "node:crypto";

import postgres from "postgres";

export async function seedStorageUploadSession(input: {
  bytes: number;
  checksumSha256: string;
  contentType: string;
  databaseUrl: string;
  key: string;
  originalName: string;
}) {
  const connection = postgres(input.databaseUrl, {
    max: 1,
    onnotice: () => undefined,
    prepare: false,
  });
  const [principal] = await connection<
    [{ actor_id: string; workspace_id: string }]
  >`
    SELECT user_id AS actor_id, workspace_id
    FROM workspace_principals
    WHERE principal_type = 'user' AND user_id IS NOT NULL
    ORDER BY created_at, id
    LIMIT 1
  `;
  if (!principal) {
    await connection.end({ timeout: 5 });
    throw new Error("Storage smoke requires a seeded workspace principal");
  }
  const uploadSessionId = randomUUID();
  const sessionExpiresAt = new Date(Date.now() + 10 * 60_000);
  await connection`
    INSERT INTO upload_sessions (
      id, workspace_id, actor_id, intended_purpose, original_name, max_bytes,
      expected_checksum, expected_media_type, object_key, state, expires_at,
      created_by, updated_by
    ) VALUES (
      ${uploadSessionId}, ${principal.workspace_id}, ${principal.actor_id},
      'EVIDENCE', ${input.originalName}, ${input.bytes}, ${input.checksumSha256},
      ${input.contentType}, ${input.key}, 'pending', ${sessionExpiresAt},
      ${principal.actor_id}, ${principal.actor_id}
    )
  `;
  return {
    actorId: principal.actor_id,
    cleanup: async () => {
      await connection`
        DELETE FROM upload_sessions
        WHERE workspace_id = ${principal.workspace_id}
          AND id = ${uploadSessionId}
      `;
      await connection.end({ timeout: 5 });
    },
    sessionExpiresAt,
    uploadSessionId,
    workspaceId: principal.workspace_id,
  };
}
