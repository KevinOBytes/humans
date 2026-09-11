CREATE TYPE "public"."approval_state" AS ENUM('requested', 'approved', 'rejected', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."governance_scope" AS ENUM('read', 'restricted_read', 'write', 'export', 'ai_operation');--> statement-breakpoint
CREATE TYPE "public"."lawful_basis" AS ENUM('consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests');--> statement-breakpoint
CREATE TYPE "public"."withdrawal_effect" AS ENUM('stop_processing', 'restrict_processing', 'retain_under_hold');--> statement-breakpoint
CREATE TABLE "access_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"scope" "governance_scope" DEFAULT 'restricted_read' NOT NULL,
	"case_reference" text,
	"reason" text NOT NULL,
	"state" "approval_state" DEFAULT 'requested' NOT NULL,
	"expires_at" timestamp (3) with time zone,
	"reviewed_at" timestamp (3) with time zone,
	"reviewed_by" text,
	"review_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "access_approvals_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "access_approvals_version_check" CHECK ("access_approvals"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "consent_scopes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"consent_record_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"scope" "governance_scope" NOT NULL,
	"field_definition_id" uuid,
	"case_reference" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "consent_scopes_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "consent_scopes_version_check" CHECK ("consent_scopes"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "field_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose_policy_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"sensitivity_ceiling" "sensitivity" DEFAULT 'internal' NOT NULL,
	"permitted_scopes" "governance_scope"[] NOT NULL,
	"case_reference" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "field_policies_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "field_policies_permitted_scopes_check" CHECK (cardinality("field_policies"."permitted_scopes") > 0),
	CONSTRAINT "field_policies_version_check" CHECK ("field_policies"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "purpose_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"state" "policy_state" DEFAULT 'draft' NOT NULL,
	"effective_from" timestamp (3) with time zone NOT NULL,
	"effective_until" timestamp (3) with time zone,
	"lawful_bases" "lawful_basis"[] NOT NULL,
	"case_reference" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "purpose_policies_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "purpose_policies_effective_interval_check" CHECK ("purpose_policies"."effective_until" IS NULL OR "purpose_policies"."effective_until" >= "purpose_policies"."effective_from"),
	CONSTRAINT "purpose_policies_lawful_bases_check" CHECK (cardinality("purpose_policies"."lawful_bases") > 0),
	CONSTRAINT "purpose_policies_version_check" CHECK ("purpose_policies"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "notice_version" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "collection_method" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "lawful_basis" "lawful_basis";--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "lawful_basis_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "withdrawal_effect" "withdrawal_effect";--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "withdrawn_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "withdrawn_by" text;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "reviewed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "consent_records" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "access_approvals" ADD CONSTRAINT "access_approvals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_approvals" ADD CONSTRAINT "access_approvals_workspace_principal_fk" FOREIGN KEY ("workspace_id","principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_approvals" ADD CONSTRAINT "access_approvals_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_approvals" ADD CONSTRAINT "access_approvals_workspace_definition_fk" FOREIGN KEY ("workspace_id","field_definition_id") REFERENCES "public"."fact_definitions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_scopes" ADD CONSTRAINT "consent_scopes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_scopes" ADD CONSTRAINT "consent_scopes_workspace_consent_fk" FOREIGN KEY ("workspace_id","consent_record_id") REFERENCES "public"."consent_records"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_scopes" ADD CONSTRAINT "consent_scopes_workspace_definition_fk" FOREIGN KEY ("workspace_id","field_definition_id") REFERENCES "public"."fact_definitions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_policies" ADD CONSTRAINT "field_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_policies" ADD CONSTRAINT "field_policies_workspace_purpose_policy_fk" FOREIGN KEY ("workspace_id","purpose_policy_id") REFERENCES "public"."purpose_policies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "field_policies" ADD CONSTRAINT "field_policies_workspace_definition_fk" FOREIGN KEY ("workspace_id","field_definition_id") REFERENCES "public"."fact_definitions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purpose_policies" ADD CONSTRAINT "purpose_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_approvals_workspace_principal_idx" ON "access_approvals" USING btree ("workspace_id","principal_id","state");--> statement-breakpoint
CREATE INDEX "consent_scopes_workspace_consent_idx" ON "consent_scopes" USING btree ("workspace_id","consent_record_id","purpose");--> statement-breakpoint
CREATE INDEX "field_policies_workspace_policy_idx" ON "field_policies" USING btree ("workspace_id","purpose_policy_id");--> statement-breakpoint
CREATE INDEX "purpose_policies_workspace_purpose_idx" ON "purpose_policies" USING btree ("workspace_id","purpose","state");--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_version_check" CHECK ("consent_records"."version" > 0);