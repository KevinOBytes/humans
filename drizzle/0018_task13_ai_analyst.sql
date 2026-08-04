DROP TRIGGER IF EXISTS ai_threads_validate_owner_trigger ON "ai_threads";--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_messages_validate_actor_trigger ON "ai_messages";--> statement-breakpoint
DROP TRIGGER IF EXISTS ai_runs_validate_actor_trigger ON "ai_runs";--> statement-breakpoint
ALTER TABLE "ai_messages" DROP CONSTRAINT IF EXISTS "ai_messages_workspace_actor_fk";--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT IF EXISTS "ai_runs_workspace_actor_fk";--> statement-breakpoint
ALTER TABLE "ai_threads" DROP CONSTRAINT IF EXISTS "ai_threads_workspace_owner_fk";--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.task13_workspace_principal_id(
	legacy_workspace_id uuid,
	legacy_user_id text,
	legacy_column text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
	matched_count bigint;
	matched_principal_id uuid;
BEGIN
	IF legacy_user_id IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT count(*), (min(principal.id::text))::uuid
	INTO matched_count, matched_principal_id
	FROM public.workspace_principals AS principal
	WHERE principal.workspace_id = legacy_workspace_id
		AND principal.user_id = legacy_user_id;

	IF matched_count <> 1 THEN
		RAISE EXCEPTION 'Task 13 migration requires exactly one workspace principal for % (workspace %, legacy user %); found %',
			legacy_column, legacy_workspace_id, legacy_user_id, matched_count
			USING ERRCODE = '23503',
				HINT = 'Repair missing or ambiguous workspace principal attribution before retrying the migration.';
	END IF;

	RETURN matched_principal_id;
END;
$$;--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "created_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "created_by", 'ai_messages.created_by');--> statement-breakpoint
ALTER TABLE "ai_messages" ALTER COLUMN "updated_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "updated_by", 'ai_messages.updated_by');--> statement-breakpoint
ALTER TABLE "ai_runs" ALTER COLUMN "created_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "created_by", 'ai_runs.created_by');--> statement-breakpoint
ALTER TABLE "ai_threads" ALTER COLUMN "owner_id" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "owner_id", 'ai_threads.owner_id');--> statement-breakpoint
ALTER TABLE "ai_threads" ALTER COLUMN "created_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "created_by", 'ai_threads.created_by');--> statement-breakpoint
ALTER TABLE "ai_threads" ALTER COLUMN "updated_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "updated_by", 'ai_threads.updated_by');--> statement-breakpoint
ALTER TABLE "ai_threads" ALTER COLUMN "deleted_by" SET DATA TYPE uuid USING public.task13_workspace_principal_id("workspace_id", "deleted_by", 'ai_threads.deleted_by');--> statement-breakpoint
DROP FUNCTION public.task13_workspace_principal_id(uuid, text, text);--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "principal_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_actor_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_deleter_fk" FOREIGN KEY ("workspace_id","deleted_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_owner_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_principal_fk" FOREIGN KEY ("workspace_id","principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_attribution_check" CHECK (num_nonnulls("jobs"."created_by", "jobs"."principal_id") <= 1 AND ("jobs"."kind" <> 'ai_execute' OR "jobs"."principal_id" IS NOT NULL));
