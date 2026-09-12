CREATE TABLE "person_web_research_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"snippet" text NOT NULL,
	"publication_date" timestamp (3) with time zone,
	"collection_timestamp" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"retrieval_hash" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"reliability" numeric(4, 3),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_web_research_sources_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_web_research_sources_run_url_unique" UNIQUE("workspace_id","run_id","url"),
	CONSTRAINT "person_web_research_sources_url_check" CHECK ("person_web_research_sources"."url" ~ '^https://'),
	CONSTRAINT "person_web_research_sources_hash_check" CHECK ("person_web_research_sources"."retrieval_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "person_web_research_sources_reliability_check" CHECK ("person_web_research_sources"."reliability" IS NULL OR "person_web_research_sources"."reliability" BETWEEN 0 AND 1),
	CONSTRAINT "person_web_research_sources_provider_check" CHECK (octet_length("person_web_research_sources"."provider") BETWEEN 1 AND 100 AND octet_length("person_web_research_sources"."model") BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" DROP CONSTRAINT "ai_review_acceptance_check";--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD COLUMN "accepted_from_run_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD COLUMN "accepted_evidence_references" jsonb;--> statement-breakpoint
ALTER TABLE "person_web_research_sources" ADD CONSTRAINT "person_web_research_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_web_research_sources" ADD CONSTRAINT "person_web_research_sources_run_fk" FOREIGN KEY ("workspace_id","run_id") REFERENCES "public"."person_web_research_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_web_research_sources" ADD CONSTRAINT "person_web_research_sources_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_web_research_sources_run_idx" ON "person_web_research_sources" USING btree ("workspace_id","run_id","id");--> statement-breakpoint
ALTER TABLE "ai_review_suggestions" ADD CONSTRAINT "ai_review_acceptance_check" CHECK (("ai_review_suggestions"."status" = 'accepted' AND "ai_review_suggestions"."accepted_resource_id" IS NOT NULL AND "ai_review_suggestions"."accepted_resource_kind" IN ('person','fact','relationship') AND "ai_review_suggestions"."accepted_from_run_id" IS NOT NULL AND "ai_review_suggestions"."accepted_evidence_references" IS NOT NULL) OR ("ai_review_suggestions"."status" <> 'accepted' AND "ai_review_suggestions"."accepted_resource_id" IS NULL AND "ai_review_suggestions"."accepted_resource_kind" IS NULL AND "ai_review_suggestions"."accepted_from_run_id" IS NULL AND "ai_review_suggestions"."accepted_evidence_references" IS NULL));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION humans_ai_review_immutable_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.workspace_id,NEW.person_id,NEW.case_id,NEW.purpose,NEW.field_key,NEW.proposed_value,NEW.evidence_references,NEW.confidence,NEW.uncertainty,NEW.provider,NEW.model,NEW.prompt_policy_version,NEW.ai_run_id,NEW.web_run_id,NEW.created_at,NEW.created_by)
    IS DISTINCT FROM ROW(OLD.id,OLD.workspace_id,OLD.person_id,OLD.case_id,OLD.purpose,OLD.field_key,OLD.proposed_value,OLD.evidence_references,OLD.confidence,OLD.uncERTAINTY,OLD.provider,OLD.model,OLD.prompt_policy_version,OLD.ai_run_id,OLD.web_run_id,OLD.created_at,OLD.created_by)
    OR OLD.status IN ('accepted','rejected') OR NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'AI proposal or final decision is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'accepted' AND NEW.accepted_from_run_id IS DISTINCT FROM COALESCE(NEW.ai_run_id, NEW.web_run_id) THEN
    RAISE EXCEPTION 'accepted AI provenance must point to the original run' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION humans_ai_web_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AI web source snapshots are immutable' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER person_web_research_sources_immutable BEFORE UPDATE ON person_web_research_sources FOR EACH ROW EXECUTE FUNCTION humans_ai_web_source_immutable();
