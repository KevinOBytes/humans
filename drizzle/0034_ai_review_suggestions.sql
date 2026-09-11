CREATE TABLE "ai_review_suggestions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"case_id" uuid,
	"purpose" text NOT NULL,
	"field_key" text NOT NULL,
	"proposed_value" jsonb NOT NULL,
	"evidence_references" jsonb NOT NULL,
	"confidence" numeric NOT NULL,
	"uncertainty" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_policy_version" text NOT NULL,
	"ai_run_id" uuid,
	"web_run_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp (3) with time zone,
	"decision_reason" text,
	"accepted_resource_id" uuid,
	"accepted_resource_kind" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "ai_review_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_review_run_check" CHECK (num_nonnulls("ai_review_suggestions"."ai_run_id", "ai_review_suggestions"."web_run_id") = 1),
	CONSTRAINT "ai_review_confidence_check" CHECK ("ai_review_suggestions"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "ai_review_evidence_check" CHECK (jsonb_typeof("ai_review_suggestions"."evidence_references") = 'array' AND jsonb_array_length("ai_review_suggestions"."evidence_references") BETWEEN 1 AND 5),
	CONSTRAINT "ai_review_value_check" CHECK ("ai_review_suggestions"."proposed_value"->>'version' = '1' AND "ai_review_suggestions"."proposed_value"->>'kind' IN ('profile', 'fact', 'relationship')),
	CONSTRAINT "ai_review_status_check" CHECK ("ai_review_suggestions"."status" IN ('pending', 'accepted', 'rejected', 'deferred') AND "ai_review_suggestions"."version" > 0),
	CONSTRAINT "ai_review_decision_check" CHECK (("ai_review_suggestions"."status" = 'pending' AND "ai_review_suggestions"."reviewed_by" IS NULL AND "ai_review_suggestions"."reviewed_at" IS NULL) OR ("ai_review_suggestions"."status" <> 'pending' AND "ai_review_suggestions"."reviewed_by" IS NOT NULL AND "ai_review_suggestions"."reviewed_at" IS NOT NULL)),
	CONSTRAINT "ai_review_acceptance_check" CHECK (("ai_review_suggestions"."status" = 'accepted' AND "ai_review_suggestions"."accepted_resource_id" IS NOT NULL AND "ai_review_suggestions"."accepted_resource_kind" IN ('person','fact','relationship')) OR ("ai_review_suggestions"."status" <> 'accepted' AND "ai_review_suggestions"."accepted_resource_id" IS NULL AND "ai_review_suggestions"."accepted_resource_kind" IS NULL)),
	CONSTRAINT "ai_review_rejection_check" CHECK ("ai_review_suggestions"."status" <> 'rejected' OR length(trim("ai_review_suggestions"."decision_reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "governance_purpose" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "governance_case_reference" text;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "review_person_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "person_web_research_runs" ADD COLUMN "governance_purpose" text;--> statement-breakpoint
ALTER TABLE "person_web_research_runs" ADD COLUMN "governance_case_reference" text;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_suggestions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_run_fk" FOREIGN KEY ("workspace_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_web_run_fk" FOREIGN KEY ("workspace_id","web_run_id") REFERENCES "public"."person_web_research_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_creator_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_updater_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_reviewer_fk" FOREIGN KEY ("workspace_id","reviewed_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_review_queue_idx" ON "ai_review_suggestions" USING btree ("workspace_id","person_id","status","created_at");
--> statement-breakpoint
CREATE FUNCTION humans_ai_review_immutable_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.person_id,NEW.case_id,NEW.purpose,NEW.field_key,NEW.proposed_value,NEW.evidence_references,NEW.confidence,NEW.uncertainty,NEW.provider,NEW.model,NEW.prompt_policy_version,NEW.ai_run_id,NEW.web_run_id,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.person_id,OLD.case_id,OLD.purpose,OLD.field_key,OLD.proposed_value,OLD.evidence_references,OLD.confidence,OLD.uncertainty,OLD.provider,OLD.model,OLD.prompt_policy_version,OLD.ai_run_id,OLD.web_run_id,OLD.created_at,OLD.created_by)
    OR OLD.status IN ('accepted','rejected') OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI proposal or final decision is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_review_immutable_proposal BEFORE UPDATE ON ai_review_suggestions FOR EACH ROW EXECUTE FUNCTION humans_ai_review_immutable_proposal();
--> statement-breakpoint
CREATE FUNCTION humans_ai_run_immutable_review_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.governance_purpose,NEW.governance_case_reference,NEW.review_person_ids) IS DISTINCT FROM ROW(OLD.governance_purpose,OLD.governance_case_reference,OLD.review_person_ids) THEN
    RAISE EXCEPTION 'AI review scope is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER ai_run_immutable_review_scope BEFORE UPDATE ON ai_runs FOR EACH ROW EXECUTE FUNCTION humans_ai_run_immutable_review_scope();
