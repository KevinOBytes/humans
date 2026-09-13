CREATE TYPE "public"."break_glass_state" AS ENUM('requested', 'approved', 'rejected', 'revoked');--> statement-breakpoint
CREATE TABLE "break_glass_access_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_principal_id" uuid NOT NULL,
	"reviewer_principal_id" uuid,
	"purpose" text NOT NULL,
	"justification" text NOT NULL,
	"case_reference" text,
	"state" "break_glass_state" DEFAULT 'requested' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	"review_reason" text,
	"revoked_at" timestamp (3) with time zone,
	"revoked_by" uuid,
	"revoke_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "break_glass_access_requests_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "break_glass_access_requests_text_check" CHECK (length(trim("break_glass_access_requests"."purpose")) BETWEEN 1 AND 200
        AND length(trim("break_glass_access_requests"."justification")) BETWEEN 20 AND 4000
        AND ("break_glass_access_requests"."review_reason" IS NULL OR length(trim("break_glass_access_requests"."review_reason")) BETWEEN 20 AND 4000)
        AND ("break_glass_access_requests"."revoke_reason" IS NULL OR length(trim("break_glass_access_requests"."revoke_reason")) BETWEEN 20 AND 4000)),
	CONSTRAINT "break_glass_access_requests_version_check" CHECK ("break_glass_access_requests"."version" > 0),
	CONSTRAINT "break_glass_access_requests_review_check" CHECK (("break_glass_access_requests"."state" = 'requested' AND "break_glass_access_requests"."reviewer_principal_id" IS NULL AND "break_glass_access_requests"."reviewed_at" IS NULL)
        OR ("break_glass_access_requests"."state" IN ('approved', 'rejected') AND "break_glass_access_requests"."reviewer_principal_id" IS NOT NULL AND "break_glass_access_requests"."reviewed_at" IS NOT NULL)
        OR ("break_glass_access_requests"."state" = 'revoked' AND "break_glass_access_requests"."reviewer_principal_id" IS NOT NULL AND "break_glass_access_requests"."reviewed_at" IS NOT NULL AND "break_glass_access_requests"."revoked_at" IS NOT NULL AND "break_glass_access_requests"."revoked_by" IS NOT NULL)),
	CONSTRAINT "break_glass_access_requests_reviewer_check" CHECK ("break_glass_access_requests"."reviewer_principal_id" IS NULL OR "break_glass_access_requests"."reviewer_principal_id" <> "break_glass_access_requests"."requester_principal_id")
);
--> statement-breakpoint
CREATE TABLE "break_glass_access_resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "break_glass_access_resources_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "break_glass_access_resources_request_resource_unique" UNIQUE("workspace_id","request_id","resource_kind","resource_id"),
	CONSTRAINT "break_glass_access_resources_kind_check" CHECK ("break_glass_access_resources"."resource_kind" IN ('person', 'fact', 'relationship', 'evidence', 'source', 'file', 'address', 'contact_point', 'place', 'note'))
);
--> statement-breakpoint
ALTER TABLE "break_glass_access_requests" ADD CONSTRAINT "break_glass_access_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_access_requests" ADD CONSTRAINT "break_glass_access_requests_workspace_requester_fk" FOREIGN KEY ("workspace_id","requester_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_access_requests" ADD CONSTRAINT "break_glass_access_requests_workspace_reviewer_fk" FOREIGN KEY ("workspace_id","reviewer_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_access_requests" ADD CONSTRAINT "break_glass_access_requests_workspace_revoker_fk" FOREIGN KEY ("workspace_id","revoked_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_access_resources" ADD CONSTRAINT "break_glass_access_resources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "break_glass_access_resources" ADD CONSTRAINT "break_glass_access_resources_workspace_request_fk" FOREIGN KEY ("workspace_id","request_id") REFERENCES "public"."break_glass_access_requests"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_glass_access_requests_workspace_state_idx" ON "break_glass_access_requests" USING btree ("workspace_id","state","expires_at");--> statement-breakpoint
CREATE INDEX "break_glass_access_requests_workspace_requester_idx" ON "break_glass_access_requests" USING btree ("workspace_id","requester_principal_id","created_at");--> statement-breakpoint
CREATE INDEX "break_glass_access_resources_lookup_idx" ON "break_glass_access_resources" USING btree ("workspace_id","resource_kind","resource_id");