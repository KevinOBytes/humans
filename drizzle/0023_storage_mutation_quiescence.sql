DROP INDEX "upload_sessions_attempt_cleanup_idx";--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "storage_mutation_settles_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE INDEX "upload_sessions_attempt_cleanup_idx" ON "upload_sessions" USING btree ("state","upload_attempt_expires_at","storage_mutation_settles_at","expires_at","id");