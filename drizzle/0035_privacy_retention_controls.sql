CREATE TYPE "public"."privacy_propagation_state" AS ENUM('pending', 'succeeded', 'failed', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_state" AS ENUM('requested', 'reviewing', 'approved', 'rejected', 'fulfilling', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."privacy_request_type" AS ENUM('access', 'correction', 'export', 'restriction', 'consent_withdrawal', 'deletion');--> statement-breakpoint
CREATE TABLE "privacy_processor_propagations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"privacy_request_id" uuid NOT NULL,
	"processor" text NOT NULL,
	"state" "privacy_propagation_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"result_code" text,
	"evidence_reference" text,
	"audit_reference" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "privacy_processor_propagations_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "privacy_processor_propagations_request_processor_unique" UNIQUE("workspace_id","privacy_request_id","processor"),
	CONSTRAINT "privacy_processor_propagations_processor_check" CHECK ("privacy_processor_propagations"."processor" IN ('files', 'search', 'cache', 'email', 'ai_provider')),
	CONSTRAINT "privacy_processor_propagations_attempts_check" CHECK ("privacy_processor_propagations"."attempts" >= 0 AND "privacy_processor_propagations"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_type" "privacy_request_type" NOT NULL,
	"state" "privacy_request_state" DEFAULT 'requested' NOT NULL,
	"requester_id" text NOT NULL,
	"case_id" uuid,
	"scope" jsonb NOT NULL,
	"purpose" text,
	"idempotency_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"due_at" timestamp (3) with time zone NOT NULL,
	"execute_after" timestamp (3) with time zone NOT NULL,
	"verified_at" timestamp (3) with time zone,
	"verified_by" text,
	"verification_evidence_id" uuid,
	"reviewed_at" timestamp (3) with time zone,
	"reviewed_by" text,
	"completion_evidence_id" uuid,
	"audit_reference" uuid,
	"legacy_deletion_request_id" uuid,
	"completed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "privacy_requests_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "privacy_requests_replay_unique" UNIQUE("workspace_id","requester_id","idempotency_hash"),
	CONSTRAINT "privacy_requests_legacy_unique" UNIQUE("legacy_deletion_request_id"),
	CONSTRAINT "privacy_requests_version_check" CHECK ("privacy_requests"."version" > 0),
	CONSTRAINT "privacy_requests_deadline_check" CHECK ("privacy_requests"."due_at" >= "privacy_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "privacy_processor_propagations" ADD CONSTRAINT "privacy_processor_propagations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_processor_propagations" ADD CONSTRAINT "privacy_processor_propagations_workspace_request_fk" FOREIGN KEY ("workspace_id","privacy_request_id") REFERENCES "public"."privacy_requests"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_workspace_verification_fk" FOREIGN KEY ("workspace_id","verification_evidence_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_workspace_completion_fk" FOREIGN KEY ("workspace_id","completion_evidence_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_workspace_legacy_fk" FOREIGN KEY ("workspace_id","legacy_deletion_request_id") REFERENCES "public"."deletion_requests"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_requests_workspace_state_due_idx" ON "privacy_requests" USING btree ("workspace_id","state","execute_after");--> statement-breakpoint
-- Preserve source deletion records. Historical requests do not acquire invented
-- requester-verification or processor-completion evidence during migration.
INSERT INTO privacy_requests (
  id, workspace_id, request_type, state, requester_id, scope,
  idempotency_hash, request_hash, due_at, execute_after,
  reviewed_at, reviewed_by, legacy_deletion_request_id, completed_at,
  version, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
)
SELECT id, workspace_id, 'deletion',
  (CASE WHEN state IN ('exporting', 'deleting') THEN 'fulfilling' ELSE state::text END)::privacy_request_state,
  requester_id,
  jsonb_build_object(
    'personIds', CASE WHEN jsonb_typeof(scope->'personIds') = 'array' THEN scope->'personIds' ELSE '[]'::jsonb END,
    'fileIds', CASE WHEN jsonb_typeof(scope->'fileIds') = 'array' THEN scope->'fileIds' ELSE '[]'::jsonb END
  ),
  'legacy:' || id::text, 'legacy:' || id::text,
  created_at + interval '30 days', created_at,
  reviewed_at, reviewed_by, id, completed_at,
  version, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by
FROM deletion_requests
ON CONFLICT DO NOTHING;
