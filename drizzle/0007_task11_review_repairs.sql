ALTER TABLE "import_rows" DROP CONSTRAINT "import_rows_workspace_row_unique";--> statement-breakpoint
ALTER TABLE "import_rows" ADD COLUMN "staging_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "staging_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "staging_owner" uuid;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "staging_lease_expires_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "cleanup_completed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "request_hash" text;--> statement-breakpoint
CREATE INDEX "upload_sessions_cleanup_due_idx" ON "upload_sessions" USING btree ("state","expires_at","id");--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_workspace_row_unique" UNIQUE("workspace_id","import_id","staging_generation","row_number");--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_staging_generation_check" CHECK ("import_rows"."staging_generation" >= 0);--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_staging_generation_check" CHECK ("imports"."staging_generation" >= 0);--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_staging_lease_check" CHECK (("imports"."staging_owner" IS NULL AND "imports"."staging_lease_expires_at" IS NULL) OR ("imports"."staging_owner" IS NOT NULL AND "imports"."staging_lease_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_request_hash_check" CHECK ("jobs"."request_hash" IS NULL OR "jobs"."request_hash" ~ '^sha256:[0-9a-f]{64}$');
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "imports"
    WHERE "state" NOT IN (
      'pending', 'staging', 'preview_ready', 'queued', 'running', 'completed',
      'completed_with_errors', 'failed', 'dead_letter'
    )
  ) THEN
    RAISE EXCEPTION 'Unsupported legacy import state. Remediate imports.state before retrying migration 0007.';
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  -- Keep the source file stable while legacy import envelopes are upgraded.
  -- The checksum and byte size become part of every subsequent retry hash, so
  -- silently inventing either value would make the retry snapshot unverifiable.
  PERFORM 1
  FROM "imports"
  JOIN "files"
    ON "files"."id" = "imports"."file_id"
    AND "files"."workspace_id" = "imports"."workspace_id"
  WHERE jsonb_typeof("imports"."mapping") = 'object'
    AND "imports"."mapping" ?& ARRAY[
      'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
    ]::text[]
    AND "imports"."mapping" - ARRAY[
      'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
    ]::text[] = '{}'::jsonb
  FOR SHARE OF "files";

  IF EXISTS (
    SELECT 1
    FROM "imports"
    LEFT JOIN "files"
      ON "files"."id" = "imports"."file_id"
      AND "files"."workspace_id" = "imports"."workspace_id"
    WHERE jsonb_typeof("imports"."mapping") = 'object'
      AND "imports"."mapping" ?& ARRAY[
        'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
      ]::text[]
      AND "imports"."mapping" - ARRAY[
        'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
      ]::text[] = '{}'::jsonb
      AND (
        "files"."id" IS NULL
        OR "files"."checksum" !~ '^sha256:[0-9a-f]{64}$'
        OR "files"."byte_size" < 0
        OR "files"."byte_size" > 9007199254740991
      )
  ) THEN
    RAISE EXCEPTION 'A legacy import has a missing or invalid file snapshot dependency. Remediate the linked file before retrying migration 0007.';
  END IF;

  UPDATE "imports"
  SET "mapping" = "imports"."mapping" || jsonb_build_object(
    'fileChecksum', "files"."checksum",
    'fileSize', "files"."byte_size"
  )
  FROM "files"
  WHERE jsonb_typeof("imports"."mapping") = 'object'
    AND "imports"."mapping" ?& ARRAY[
      'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
    ]::text[]
    AND "imports"."mapping" - ARRAY[
      'definition', 'mappingHash', 'mappingId', 'mappingVersion', 'mode', 'requestHash'
    ]::text[] = '{}'::jsonb
    AND "files"."id" = "imports"."file_id"
    AND "files"."workspace_id" = "imports"."workspace_id";
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "imports"
    JOIN "jobs" ON "jobs"."id" = "imports"."id"
    WHERE "imports"."execution_job_id" IS NULL
      AND "imports"."state" IN ('pending', 'preview_ready', 'queued', 'running', 'completed_with_errors', 'failed', 'dead_letter')
      AND NOT (
        "jobs"."workspace_id" = "imports"."workspace_id"
        AND "jobs"."kind" = 'import_execute'
        AND "jobs"."idempotency_key" = 'legacy-import-tombstone:' || "imports"."id"::text
        AND "jobs"."state" = 'dead_letter'
        AND "jobs"."error_code" = 'legacy_import_reconciled'
      )
  ) THEN
    RAISE EXCEPTION 'A legacy import ID collides with an unrelated job. Remediate the collision before retrying migration 0007.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "imports"
    JOIN "jobs"
      ON "jobs"."workspace_id" = "imports"."workspace_id"
      AND "jobs"."kind" = 'import_execute'
      AND "jobs"."idempotency_key" = 'legacy-import-tombstone:' || "imports"."id"::text
    WHERE "imports"."execution_job_id" IS NULL
      AND "imports"."state" IN ('pending', 'preview_ready', 'queued', 'running', 'completed_with_errors', 'failed', 'dead_letter')
      AND NOT (
        "jobs"."state" = 'dead_letter'
        AND "jobs"."error_code" = 'legacy_import_reconciled'
        AND "jobs"."encrypted_payload" = 'migration:tombstone'
        AND "jobs"."payload_hash" = 'sha256:' || repeat('0', 64)
      )
  ) THEN
    RAISE EXCEPTION 'A legacy import tombstone idempotency key is already used by an incompatible job. Remediate the collision before retrying migration 0007.';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM "imports"
    JOIN "audit_events" ON "audit_events"."id" = "imports"."id"
    WHERE "imports"."execution_job_id" IS NULL
      AND "imports"."state" IN ('pending', 'preview_ready', 'queued', 'running', 'completed_with_errors', 'failed', 'dead_letter')
      AND NOT (
        "audit_events"."workspace_id" = "imports"."workspace_id"
        AND "audit_events"."action" = 'import.migration_dead_lettered'
        AND "audit_events"."resource_kind" = 'import'
        AND "audit_events"."resource_id" = "imports"."id"
      )
  ) THEN
    RAISE EXCEPTION 'A legacy import ID collides with an unrelated audit event. Remediate the collision before retrying migration 0007.';
  END IF;
END $$;
--> statement-breakpoint
WITH "legacy_imports" AS (
  SELECT "imports".*
  FROM "imports"
  WHERE "imports"."execution_job_id" IS NULL
    AND "imports"."state" IN ('pending', 'preview_ready', 'queued', 'running', 'completed_with_errors', 'failed', 'dead_letter')
), "created_jobs" AS (
  INSERT INTO "jobs" (
    "id", "workspace_id", "kind", "encrypted_payload", "payload_hash",
    "idempotency_key", "state", "error_code", "result_references",
    "created_at", "updated_at"
  )
  SELECT
    "legacy_imports"."id", "legacy_imports"."workspace_id", 'import_execute',
    'migration:tombstone', 'sha256:' || repeat('0', 64),
    'legacy-import-tombstone:' || "legacy_imports"."id"::text,
    'dead_letter', 'legacy_import_reconciled', '[]'::jsonb,
    clock_timestamp(), clock_timestamp()
  FROM "legacy_imports"
  WHERE NOT EXISTS (
    SELECT 1
    FROM "jobs"
    WHERE "jobs"."workspace_id" = "legacy_imports"."workspace_id"
      AND "jobs"."kind" = 'import_execute'
      AND "jobs"."idempotency_key" = 'legacy-import-tombstone:' || "legacy_imports"."id"::text
  )
  ON CONFLICT ("workspace_id", "kind", "idempotency_key") DO NOTHING
  RETURNING "id", "workspace_id", "idempotency_key"
), "tombstones" AS (
  SELECT
    "legacy_imports"."workspace_id",
    "legacy_imports"."id" AS "import_id",
    "jobs"."id" AS "job_id"
  FROM "legacy_imports"
  JOIN "jobs"
    ON "jobs"."workspace_id" = "legacy_imports"."workspace_id"
    AND "jobs"."kind" = 'import_execute'
    AND "jobs"."idempotency_key" = 'legacy-import-tombstone:' || "legacy_imports"."id"::text
    AND "jobs"."state" = 'dead_letter'
    AND "jobs"."error_code" = 'legacy_import_reconciled'
  UNION ALL
  SELECT
    "legacy_imports"."workspace_id",
    "legacy_imports"."id" AS "import_id",
    "created_jobs"."id" AS "job_id"
  FROM "legacy_imports"
  JOIN "created_jobs"
    ON "created_jobs"."workspace_id" = "legacy_imports"."workspace_id"
    AND "created_jobs"."idempotency_key" = 'legacy-import-tombstone:' || "legacy_imports"."id"::text
), "normalized" AS (
  UPDATE "imports"
  SET
    "execution_job_id" = "tombstones"."job_id",
    "state" = 'dead_letter',
    "completed_at" = COALESCE("imports"."completed_at", clock_timestamp()),
    "updated_at" = clock_timestamp(),
    "version" = "imports"."version" + 1
  FROM "tombstones"
  WHERE "imports"."workspace_id" = "tombstones"."workspace_id"
    AND "imports"."id" = "tombstones"."import_id"
  RETURNING "imports"."workspace_id", "imports"."id", "imports"."execution_job_id"
)
INSERT INTO "audit_events" (
  "id", "workspace_id", "action", "resource_kind", "resource_id",
  "request_id", "outcome", "redacted_diff", "occurred_at"
)
SELECT
  "normalized"."id",
  "normalized"."workspace_id", 'import.migration_dead_lettered', 'import',
  "normalized"."id", 'migration:0007', 'dead_letter',
  jsonb_build_object('jobId', "normalized"."execution_job_id", 'state', 'dead_letter'),
  clock_timestamp()
FROM "normalized";
