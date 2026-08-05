CREATE TABLE "ai_ephemeral_inputs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"encrypted_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"claimed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_ephemeral_inputs_workspace_run_unique" UNIQUE("workspace_id","ai_run_id")
);
--> statement-breakpoint
ALTER TABLE "ai_ephemeral_inputs" ADD CONSTRAINT "ai_ephemeral_inputs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_ephemeral_inputs" ADD CONSTRAINT "ai_ephemeral_inputs_workspace_run_fk" FOREIGN KEY ("workspace_id","thread_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","thread_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_ephemeral_inputs_expiry_idx" ON "ai_ephemeral_inputs" USING btree ("expires_at");