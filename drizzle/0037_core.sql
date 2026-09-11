CREATE TABLE "export_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid,
	"purpose" text NOT NULL,
	"preview_hash" text NOT NULL,
	"redaction_profile" text NOT NULL,
	"requested_by_principal_id" uuid NOT NULL,
	"reviewed_by_principal_id" uuid,
	"state" text DEFAULT 'requested' NOT NULL,
	"request_reason" text NOT NULL,
	"decision_reason" text,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	"request_audit_reference" uuid NOT NULL,
	"review_audit_reference" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "export_approvals_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "export_approvals_binding_check" CHECK (octet_length("export_approvals"."purpose") BETWEEN 1 AND 200 AND "export_approvals"."preview_hash" ~ '^[0-9a-f]{64}$' AND "export_approvals"."redaction_profile" IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED')),
	CONSTRAINT "export_approvals_reason_check" CHECK (octet_length("export_approvals"."request_reason") BETWEEN 1 AND 1000 AND ("export_approvals"."decision_reason" IS NULL OR octet_length("export_approvals"."decision_reason") BETWEEN 1 AND 1000)),
	CONSTRAINT "export_approvals_review_check" CHECK ("export_approvals"."created_by" = "export_approvals"."requested_by_principal_id" AND "export_approvals"."request_audit_reference" IS NOT NULL AND (("export_approvals"."state" = 'requested' AND "export_approvals"."updated_by" = "export_approvals"."requested_by_principal_id" AND "export_approvals"."reviewed_by_principal_id" IS NULL AND "export_approvals"."reviewed_at" IS NULL AND "export_approvals"."decision_reason" IS NULL AND "export_approvals"."review_audit_reference" IS NULL) OR ("export_approvals"."state" IN ('approved', 'rejected') AND "export_approvals"."updated_by" = "export_approvals"."reviewed_by_principal_id" AND "export_approvals"."reviewed_by_principal_id" IS NOT NULL AND "export_approvals"."reviewed_at" IS NOT NULL AND "export_approvals"."decision_reason" IS NOT NULL AND "export_approvals"."review_audit_reference" IS NOT NULL))),
	CONSTRAINT "export_approvals_expiry_check" CHECK ("export_approvals"."expires_at" > "export_approvals"."created_at" AND ("export_approvals"."reviewed_at" IS NULL OR "export_approvals"."reviewed_at" < "export_approvals"."expires_at")),
	CONSTRAINT "export_approvals_version_check" CHECK ("export_approvals"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_requester_fk" FOREIGN KEY ("workspace_id","requested_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_reviewer_fk" FOREIGN KEY ("workspace_id","reviewed_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_request_audit_fk" FOREIGN KEY ("workspace_id","request_audit_reference") REFERENCES "public"."audit_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_approvals" ADD CONSTRAINT "export_approvals_workspace_review_audit_fk" FOREIGN KEY ("workspace_id","review_audit_reference") REFERENCES "public"."audit_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_approvals_workspace_binding_idx" ON "export_approvals" USING btree ("workspace_id","requested_by_principal_id","preview_hash","state","expires_at");--> statement-breakpoint
CREATE INDEX "export_approvals_workspace_review_idx" ON "export_approvals" USING btree ("workspace_id","state","created_at","id");