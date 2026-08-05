ALTER TABLE "webhook_deliveries" ADD COLUMN "encrypted_payload" text;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "payload_hash" text;--> statement-breakpoint
UPDATE "webhook_deliveries"
SET "encrypted_payload" = 'legacy-unavailable',
    "payload_hash" = 'sha256:' || repeat('0', 64),
    "completed_at" = COALESCE("completed_at", now()),
    "redacted_error" = COALESCE("redacted_error", jsonb_build_object('code', 'legacy_payload_unavailable'))
WHERE "encrypted_payload" IS NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "encrypted_payload" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ALTER COLUMN "payload_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payload_hash_check" CHECK ("webhook_deliveries"."payload_hash" ~ '^sha256:[0-9a-f]{64}$');
