CREATE TABLE "export_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"case_id" uuid,
	"purpose" text NOT NULL,
	"query_hash" text NOT NULL,
	"preview_hash" text NOT NULL,
	"redaction_profile" text NOT NULL,
	"format" text NOT NULL,
	"state" text DEFAULT 'writing' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"row_count" integer NOT NULL,
	"field_counts" jsonb NOT NULL,
	"legal_hold_checked_at" timestamp (3) with time zone NOT NULL,
	"idempotency_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"audit_reference" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "export_artifacts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "export_artifacts_workspace_file_unique" UNIQUE("workspace_id","file_id"),
	CONSTRAINT "export_artifacts_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_hash"),
	CONSTRAINT "export_artifacts_hashes_check" CHECK ("export_artifacts"."query_hash" ~ '^[0-9a-f]{64}$' AND "export_artifacts"."preview_hash" ~ '^[0-9a-f]{64}$' AND "export_artifacts"."idempotency_hash" ~ '^[0-9a-f]{64}$' AND "export_artifacts"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "export_artifacts_profile_format_state_check" CHECK ("export_artifacts"."redaction_profile" IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED') AND "export_artifacts"."format" IN ('JSON', 'CSV') AND "export_artifacts"."state" IN ('writing', 'ready', 'failed', 'expired')),
	CONSTRAINT "export_artifacts_counts_check" CHECK ("export_artifacts"."row_count" >= 0 AND jsonb_typeof("export_artifacts"."field_counts") = 'object' AND "export_artifacts"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_workspace_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_artifacts_workspace_list_idx" ON "export_artifacts" USING btree ("workspace_id","created_at","id");