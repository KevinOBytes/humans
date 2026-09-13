CREATE TABLE "investigation_case_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"investigation_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" uuid,
	CONSTRAINT "investigation_case_links_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "investigation_case_links_investigation_case_unique" UNIQUE("workspace_id","investigation_id","case_id"),
	CONSTRAINT "investigation_case_links_version_check" CHECK ("investigation_case_links"."version" > 0),
	CONSTRAINT "investigation_case_links_deleted_attribution_check" CHECK (("investigation_case_links"."deleted_at" IS NULL AND "investigation_case_links"."deleted_by" IS NULL) OR ("investigation_case_links"."deleted_at" IS NOT NULL AND "investigation_case_links"."deleted_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "investigation_sequences" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"next_number" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "investigation_sequences_next_number_check" CHECK ("investigation_sequences"."next_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "investigations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"objective" text NOT NULL,
	"purpose" text NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"lead_principal_id" uuid NOT NULL,
	"started_at" timestamp (3) with time zone,
	"ended_at" timestamp (3) with time zone,
	"closed_at" timestamp (3) with time zone,
	"closed_by" uuid,
	"closure_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" uuid,
	CONSTRAINT "investigations_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "investigations_workspace_number_unique" UNIQUE("workspace_id","number"),
	CONSTRAINT "investigations_workspace_slug_unique" UNIQUE("workspace_id","slug"),
	CONSTRAINT "investigations_state_check" CHECK ("investigations"."state" IN ('draft', 'active', 'paused', 'closed', 'archived')),
	CONSTRAINT "investigations_number_check" CHECK ("investigations"."number" > 0),
	CONSTRAINT "investigations_slug_check" CHECK ("investigations"."slug" ~ '^[a-z0-9][a-z0-9-]{0,95}$'),
	CONSTRAINT "investigations_text_check" CHECK (length(trim("investigations"."title")) BETWEEN 1 AND 200 AND length(trim("investigations"."objective")) BETWEEN 1 AND 4000 AND length(trim("investigations"."purpose")) BETWEEN 1 AND 2000 AND ("investigations"."closure_reason" IS NULL OR length(trim("investigations"."closure_reason")) BETWEEN 1 AND 2000)),
	CONSTRAINT "investigations_dates_check" CHECK (("investigations"."ended_at" IS NULL OR "investigations"."started_at" IS NULL OR "investigations"."ended_at" >= "investigations"."started_at") AND ("investigations"."closed_at" IS NULL OR "investigations"."started_at" IS NULL OR "investigations"."closed_at" >= "investigations"."started_at") AND (("investigations"."state" = 'closed' AND "investigations"."closed_at" IS NOT NULL AND "investigations"."closed_by" IS NOT NULL) OR "investigations"."state" <> 'closed')),
	CONSTRAINT "investigations_version_check" CHECK ("investigations"."version" > 0),
	CONSTRAINT "investigations_deleted_attribution_check" CHECK (("investigations"."deleted_at" IS NULL AND "investigations"."deleted_by" IS NULL) OR ("investigations"."deleted_at" IS NOT NULL AND "investigations"."deleted_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "case_team_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" uuid,
	CONSTRAINT "case_team_links_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "case_team_links_case_team_unique" UNIQUE("workspace_id","case_id","team_id"),
	CONSTRAINT "case_team_links_version_check" CHECK ("case_team_links"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "investigation_case_links" ADD CONSTRAINT "investigation_case_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_case_links" ADD CONSTRAINT "investigation_case_links_workspace_investigation_fk" FOREIGN KEY ("workspace_id","investigation_id") REFERENCES "public"."investigations"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_case_links" ADD CONSTRAINT "investigation_case_links_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigation_sequences" ADD CONSTRAINT "investigation_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_lead_fk" FOREIGN KEY ("workspace_id","lead_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investigations" ADD CONSTRAINT "investigations_workspace_closed_by_fk" FOREIGN KEY ("workspace_id","closed_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_team_links" ADD CONSTRAINT "case_team_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_team_links" ADD CONSTRAINT "case_team_links_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_team_links" ADD CONSTRAINT "case_team_links_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investigation_case_links_case_idx" ON "investigation_case_links" USING btree ("workspace_id","case_id","investigation_id");--> statement-breakpoint
CREATE INDEX "investigations_workspace_state_idx" ON "investigations" USING btree ("workspace_id","state","created_at","id");--> statement-breakpoint
CREATE INDEX "investigations_workspace_lead_idx" ON "investigations" USING btree ("workspace_id","lead_principal_id","id");--> statement-breakpoint
CREATE INDEX "case_team_links_workspace_case_idx" ON "case_team_links" USING btree ("workspace_id","case_id","id");--> statement-breakpoint
CREATE INDEX "case_team_links_workspace_team_idx" ON "case_team_links" USING btree ("workspace_id","team_id","id");