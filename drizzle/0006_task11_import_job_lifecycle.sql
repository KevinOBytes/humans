ALTER TABLE "imports" ADD COLUMN "execution_job_id" uuid;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "claim_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_execution_job_fk" FOREIGN KEY ("workspace_id","execution_job_id") REFERENCES "public"."jobs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_execution_job_unique" UNIQUE("workspace_id","execution_job_id");--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_claim_generation_check" CHECK ("jobs"."claim_generation" >= 0);
