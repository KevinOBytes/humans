CREATE TABLE "privacy_execution_outcomes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"privacy_request_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"claim_expires_at" timestamp (3) with time zone,
	"result_code" text,
	"audit_reference" uuid,
	"manifest" jsonb,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "privacy_execution_outcomes_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "privacy_execution_outcomes_request_unique" UNIQUE("workspace_id","privacy_request_id"),
	CONSTRAINT "privacy_execution_outcomes_generation_check" CHECK ("privacy_execution_outcomes"."generation" >= 0),
	CONSTRAINT "privacy_execution_outcomes_state_check" CHECK (("privacy_execution_outcomes"."state" = 'pending' AND "privacy_execution_outcomes"."claim_expires_at" IS NULL AND "privacy_execution_outcomes"."result_code" IS NULL AND "privacy_execution_outcomes"."audit_reference" IS NULL AND "privacy_execution_outcomes"."manifest" IS NULL AND "privacy_execution_outcomes"."completed_at" IS NULL)
    OR ("privacy_execution_outcomes"."state" = 'claimed' AND "privacy_execution_outcomes"."generation" > 0 AND "privacy_execution_outcomes"."claim_expires_at" IS NOT NULL AND "privacy_execution_outcomes"."result_code" IS NULL AND "privacy_execution_outcomes"."audit_reference" IS NULL AND "privacy_execution_outcomes"."manifest" IS NULL AND "privacy_execution_outcomes"."completed_at" IS NULL)
    OR ("privacy_execution_outcomes"."state" IN ('completed', 'rejected') AND "privacy_execution_outcomes"."generation" > 0 AND "privacy_execution_outcomes"."claim_expires_at" IS NULL AND "privacy_execution_outcomes"."result_code" IS NOT NULL AND "privacy_execution_outcomes"."audit_reference" IS NOT NULL AND "privacy_execution_outcomes"."manifest" IS NOT NULL AND "privacy_execution_outcomes"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD COLUMN "execution_contract" jsonb;--> statement-breakpoint
ALTER TABLE "privacy_execution_outcomes" ADD CONSTRAINT "privacy_execution_outcomes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_execution_outcomes" ADD CONSTRAINT "privacy_execution_outcomes_request_fk" FOREIGN KEY ("workspace_id","privacy_request_id") REFERENCES "public"."privacy_requests"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_execution_outcomes" ADD CONSTRAINT "privacy_execution_outcomes_audit_fk" FOREIGN KEY ("workspace_id","audit_reference") REFERENCES "public"."audit_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;