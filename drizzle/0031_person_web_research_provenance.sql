CREATE TABLE "person_web_research_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"query_hash" text NOT NULL,
	"source_count" integer DEFAULT 0 NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suggestions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"consented_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "person_web_research_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_web_research_runs_source_count_check" CHECK ("person_web_research_runs"."source_count" BETWEEN 0 AND 5),
	CONSTRAINT "person_web_research_runs_sources_array_check" CHECK (jsonb_typeof("person_web_research_runs"."sources") = 'array'),
	CONSTRAINT "person_web_research_runs_suggestions_array_check" CHECK (jsonb_typeof("person_web_research_runs"."suggestions") = 'array'),
	CONSTRAINT "person_web_research_runs_provider_length_check" CHECK (octet_length("person_web_research_runs"."provider") BETWEEN 1 AND 100),
	CONSTRAINT "person_web_research_runs_model_length_check" CHECK (octet_length("person_web_research_runs"."model") BETWEEN 1 AND 200),
	CONSTRAINT "person_web_research_runs_query_hash_check" CHECK ("person_web_research_runs"."query_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "person_web_research_runs" ADD CONSTRAINT "person_web_research_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_web_research_runs" ADD CONSTRAINT "person_web_research_runs_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "person_web_research_runs_workspace_person_idx" ON "person_web_research_runs" USING btree ("workspace_id","person_id","created_at");