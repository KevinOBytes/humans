ALTER TABLE "upload_sessions" ADD COLUMN "original_name" text;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "sensitivity" "sensitivity";--> statement-breakpoint
WITH "legacy_metadata" AS (
	SELECT
		"upload_sessions"."id",
		CASE
			WHEN "files"."id" IS NOT NULL
				AND octet_length("files"."original_name") BETWEEN 1 AND 255
			THEN "files"."original_name"
			ELSE 'metadata-unavailable'
		END AS "original_name",
		CASE
			WHEN "files"."id" IS NOT NULL
			THEN "files"."sensitivity"
			ELSE 'internal'::"sensitivity"
		END AS "sensitivity"
	FROM "upload_sessions"
	LEFT JOIN "files"
		ON "files"."workspace_id" = "upload_sessions"."workspace_id"
		AND "files"."id" = "upload_sessions"."file_id"
)
UPDATE "upload_sessions"
SET
	"original_name" = "legacy_metadata"."original_name",
	"sensitivity" = "legacy_metadata"."sensitivity"
FROM "legacy_metadata"
WHERE "upload_sessions"."id" = "legacy_metadata"."id";--> statement-breakpoint
UPDATE "upload_sessions"
SET
	"state" = 'cleanup_pending',
	"failure_code" = 'metadata_unavailable'
WHERE "state" IN ('pending', 'verifying');--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "original_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "sensitivity" SET DEFAULT 'internal';--> statement-breakpoint
ALTER TABLE "upload_sessions" ALTER COLUMN "sensitivity" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_original_name_bytes_check" CHECK (octet_length("upload_sessions"."original_name") BETWEEN 1 AND 255);
