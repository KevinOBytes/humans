CREATE TABLE "team_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" uuid,
	CONSTRAINT "team_members_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "team_members_principal_unique" UNIQUE("workspace_id","team_id","principal_id"),
	CONSTRAINT "team_members_role_check" CHECK ("team_members"."role" IN ('owner', 'reviewer', 'member')),
	CONSTRAINT "team_members_version_check" CHECK ("team_members"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"state" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" uuid,
	CONSTRAINT "teams_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "teams_workspace_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "teams_state_check" CHECK ("teams"."state" IN ('active', 'archived')),
	CONSTRAINT "teams_text_check" CHECK (length(trim("teams"."name")) BETWEEN 1 AND 160 AND ("teams"."description" IS NULL OR length("teams"."description") <= 2000)),
	CONSTRAINT "teams_version_check" CHECK ("teams"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_team_fk" FOREIGN KEY ("workspace_id","team_id") REFERENCES "public"."teams"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_workspace_principal_fk" FOREIGN KEY ("workspace_id","principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_members_workspace_team_idx" ON "team_members" USING btree ("workspace_id","team_id","role","id");--> statement-breakpoint
CREATE INDEX "teams_workspace_state_idx" ON "teams" USING btree ("workspace_id","state","id");