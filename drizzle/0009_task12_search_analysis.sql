DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "search_documents" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "saved_queries" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "query_runs" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "graph_snapshots" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "analysis_runs" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "analysis_results" LIMIT 1)
    OR EXISTS (SELECT 1 FROM "person_metrics" LIMIT 1)
  THEN
    RAISE EXCEPTION '0009_task12_search_analysis requires empty provisional search and analysis tables; reindex and recreate deterministic snapshots after migration';
  END IF;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS query_runs_validate_actor_trigger ON "query_runs";--> statement-breakpoint
DROP TRIGGER IF EXISTS saved_queries_validate_owner_trigger ON "saved_queries";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP CONSTRAINT "saved_queries_workspace_owner_name_unique";--> statement-breakpoint
ALTER TABLE "search_documents" DROP CONSTRAINT "search_documents_workspace_resource_unique";--> statement-breakpoint
ALTER TABLE "query_runs" DROP CONSTRAINT "query_runs_metrics_check";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP CONSTRAINT "saved_queries_definition_check";--> statement-breakpoint
ALTER TABLE "query_runs" DROP CONSTRAINT "query_runs_workspace_actor_fk";
--> statement-breakpoint
ALTER TABLE "saved_queries" DROP CONSTRAINT "saved_queries_workspace_owner_fk";
--> statement-breakpoint
DROP INDEX "search_documents_workspace_resource_idx";--> statement-breakpoint
ALTER TABLE "saved_queries" ALTER COLUMN "sharing" SET DEFAULT 'PRIVATE';--> statement-breakpoint
ALTER TABLE "saved_queries" ALTER COLUMN "created_by" SET DATA TYPE uuid USING "created_by"::uuid;--> statement-breakpoint
ALTER TABLE "saved_queries" ALTER COLUMN "updated_by" SET DATA TYPE uuid USING "updated_by"::uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "title_text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "body_text" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "display_text" text NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" drop column "search_vector";--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title_text", '')), 'A') || setweight(to_tsvector('simple', coalesce("body_text", '')), 'C')) STORED NOT NULL;--> statement-breakpoint
CREATE INDEX "search_documents_search_vector_gin" ON "search_documents" USING gin ("search_vector");--> statement-breakpoint
ALTER TABLE "analysis_results" ADD COLUMN "payload_schema" text NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD COLUMN "payload_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD COLUMN "export_label" text NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "algorithm_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "configuration_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "actor_principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD COLUMN "actor_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "manifest_schema" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "manifest_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "manifest_material" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "query_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "authorization_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "actor_principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "actor_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "included_relationship_type_versions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "algorithm" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "algorithm_version" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "algorithm_config_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD COLUMN "runtime_contract" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "query_runs" ADD COLUMN "actor_principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "query_runs" ADD COLUMN "actor_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "query_runs" ADD COLUMN "query_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "query_runs" ADD COLUMN "outcome" text NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "owner_principal_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "query_ast" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "ast_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "query_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "archived_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "source_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "source_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "chunk_ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "result_kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "result_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "subject_person_id" uuid;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "sensitivity" "sensitivity" NOT NULL;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "document_schema_version" smallint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_workspace_actor_principal_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_workspace_actor_principal_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_workspace_actor_principal_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION task12_validate_principal_actor_kind()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  stored_principal_type text;
BEGIN
  SELECT principal_type INTO stored_principal_type
  FROM workspace_principals
  WHERE workspace_id = NEW.workspace_id AND id = NEW.actor_principal_id;
  IF stored_principal_type IS NULL
    OR (NEW.actor_kind = 'USER' AND stored_principal_type <> 'user')
    OR (NEW.actor_kind = 'API_KEY' AND stored_principal_type <> 'api_key')
  THEN
    RAISE EXCEPTION 'actor kind does not match workspace principal' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER query_runs_validate_actor_kind_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_principal_id, actor_kind ON "query_runs" FOR EACH ROW EXECUTE FUNCTION task12_validate_principal_actor_kind();--> statement-breakpoint
CREATE TRIGGER graph_snapshots_validate_actor_kind_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_principal_id, actor_kind ON "graph_snapshots" FOR EACH ROW EXECUTE FUNCTION task12_validate_principal_actor_kind();--> statement-breakpoint
CREATE TRIGGER analysis_runs_validate_actor_kind_trigger BEFORE INSERT OR UPDATE OF workspace_id, actor_principal_id, actor_kind ON "analysis_runs" FOR EACH ROW EXECUTE FUNCTION task12_validate_principal_actor_kind();--> statement-breakpoint
CREATE OR REPLACE FUNCTION task12_validate_saved_query_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workspace_principals wp
    INNER JOIN members m
      ON m.workspace_id = wp.workspace_id
     AND m.id = wp.member_id_snapshot
     AND m.user_id = wp.user_id
    WHERE wp.workspace_id = NEW.workspace_id
      AND wp.id = NEW.owner_principal_id
      AND wp.principal_type = 'user'
  ) THEN
    RAISE EXCEPTION 'saved query owner must be an active user principal'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER saved_queries_validate_owner_trigger BEFORE INSERT OR UPDATE OF workspace_id, owner_principal_id ON "saved_queries" FOR EACH ROW EXECUTE FUNCTION task12_validate_saved_query_owner();--> statement-breakpoint
CREATE OR REPLACE FUNCTION task12_reject_immutable_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Task 12 immutable record cannot be updated'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER graph_snapshots_immutable_trigger BEFORE UPDATE ON "graph_snapshots" FOR EACH ROW EXECUTE FUNCTION task12_reject_immutable_update();--> statement-breakpoint
CREATE TRIGGER analysis_results_immutable_trigger BEFORE UPDATE ON "analysis_results" FOR EACH ROW EXECUTE FUNCTION task12_reject_immutable_update();--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_owner_principal_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_creator_principal_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_updater_principal_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_archiver_principal_fk" FOREIGN KEY ("workspace_id","archived_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_subject_person_fk" FOREIGN KEY ("workspace_id","subject_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "graph_snapshots_workspace_manifest_idx" ON "graph_snapshots" USING btree ("workspace_id","manifest_hash","generated_at");--> statement-breakpoint
CREATE INDEX "query_runs_workspace_actor_idx" ON "query_runs" USING btree ("workspace_id","actor_principal_id","started_at");--> statement-breakpoint
CREATE INDEX "saved_queries_workspace_list_idx" ON "saved_queries" USING btree ("workspace_id","sharing","archived_at","name","id");--> statement-breakpoint
CREATE INDEX "search_documents_workspace_source_idx" ON "search_documents" USING btree ("workspace_id","source_kind","source_id","source_version");--> statement-breakpoint
CREATE INDEX "search_documents_workspace_result_page_idx" ON "search_documents" USING btree ("workspace_id","result_kind","result_id","updated_at");--> statement-breakpoint
CREATE INDEX "search_documents_workspace_subject_idx" ON "search_documents" USING btree ("workspace_id","subject_person_id","result_kind");--> statement-breakpoint
ALTER TABLE "query_runs" DROP COLUMN "actor_id";--> statement-breakpoint
ALTER TABLE "query_runs" DROP COLUMN "normalized_input_hash";--> statement-breakpoint
ALTER TABLE "query_runs" DROP COLUMN "redacted_error_metadata";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "owner_id";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "graphql_document";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "structured_filter";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "variables";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "saved_queries" DROP COLUMN "deleted_by";--> statement-breakpoint
ALTER TABLE "search_documents" DROP COLUMN "resource_kind";--> statement-breakpoint
ALTER TABLE "search_documents" DROP COLUMN "resource_id";--> statement-breakpoint
ALTER TABLE "search_documents" DROP COLUMN "redacted_text";--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_owner_name_unique" UNIQUE("workspace_id","owner_principal_id","name");--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_source_chunk_unique" UNIQUE("workspace_id","source_kind","source_id","chunk_ordinal","document_schema_version");--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_payload_check" CHECK ("analysis_results"."payload_schema" = 'humans.graph-analysis-result.v1' AND "analysis_results"."payload_hash" ~ '^[0-9a-f]{64}$' AND "analysis_results"."result_kind" IN ('degree', 'pagerank', 'community') AND octet_length("analysis_results"."export_label") BETWEEN 1 AND 120 AND ("analysis_results"."text_value" IS NULL OR octet_length("analysis_results"."text_value") <= 8192) AND ("analysis_results"."json_value" IS NULL OR octet_length("analysis_results"."json_value"::text) <= 32768) AND ("analysis_results"."explanation" IS NULL OR octet_length("analysis_results"."explanation") <= 1024));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_contract_check" CHECK ("analysis_runs"."configuration_hash" ~ '^[0-9a-f]{64}$' AND "analysis_runs"."actor_kind" IN ('USER', 'API_KEY') AND "analysis_runs"."algorithm" IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY') AND octet_length("analysis_runs"."algorithm_version") BETWEEN 1 AND 256 AND jsonb_typeof("analysis_runs"."configuration") = 'object' AND "analysis_runs"."configuration" <> '{}'::jsonb AND octet_length("analysis_runs"."configuration"::text) <= 32768 AND "analysis_runs"."state" IN ('pending', 'running', 'completed', 'failed', 'cancelled') AND ("analysis_runs"."error_summary" IS NULL OR (jsonb_typeof("analysis_runs"."error_summary") = 'object' AND octet_length("analysis_runs"."error_summary"::text) <= 32768)));--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_timing_check";--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_timing_check" CHECK (("analysis_runs"."state" IN ('pending', 'running') AND "analysis_runs"."completed_at" IS NULL) OR ("analysis_runs"."state" IN ('completed', 'failed', 'cancelled') AND "analysis_runs"."started_at" IS NOT NULL AND "analysis_runs"."completed_at" IS NOT NULL AND "analysis_runs"."completed_at" >= "analysis_runs"."started_at"));--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_manifest_check" CHECK ("graph_snapshots"."manifest_schema" = 'humans.graph-snapshot-manifest.v1' AND "graph_snapshots"."manifest_hash" ~ '^[0-9a-f]{64}$' AND "graph_snapshots"."query_hash" ~ '^[0-9a-f]{64}$' AND "graph_snapshots"."authorization_hash" ~ '^[0-9a-f]{64}$' AND "graph_snapshots"."algorithm_config_hash" ~ '^[0-9a-f]{64}$' AND "graph_snapshots"."actor_kind" IN ('USER', 'API_KEY') AND "graph_snapshots"."algorithm" IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY') AND octet_length("graph_snapshots"."algorithm_version") BETWEEN 1 AND 256 AND jsonb_typeof("graph_snapshots"."query_input") = 'object' AND octet_length("graph_snapshots"."query_input"::text) <= 32768 AND jsonb_typeof("graph_snapshots"."included_person_versions") = 'object' AND octet_length("graph_snapshots"."included_person_versions"::text) <= 2000000 AND jsonb_typeof("graph_snapshots"."included_relationship_versions") = 'object' AND octet_length("graph_snapshots"."included_relationship_versions"::text) <= 2000000 AND jsonb_typeof("graph_snapshots"."included_relationship_type_versions") = 'object' AND octet_length("graph_snapshots"."included_relationship_type_versions"::text) <= 2000000 AND jsonb_typeof("graph_snapshots"."algorithm_configuration") = 'object' AND "graph_snapshots"."algorithm_configuration" <> '{}'::jsonb AND octet_length("graph_snapshots"."algorithm_configuration"::text) <= 32768 AND jsonb_typeof("graph_snapshots"."runtime_contract") = 'object' AND "graph_snapshots"."runtime_contract" <> '{}'::jsonb AND octet_length("graph_snapshots"."runtime_contract"::text) <= 32768);--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_manifest_material_check" CHECK (jsonb_typeof("graph_snapshots"."manifest_material") = 'object' AND "graph_snapshots"."manifest_material" <> '{}'::jsonb AND octet_length("graph_snapshots"."manifest_material"::text) <= 33554432);--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_actor_kind_check" CHECK ("query_runs"."actor_kind" IN ('USER', 'API_KEY'));--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_hash_outcome_check" CHECK ("query_runs"."query_hash" ~ '^[0-9a-f]{64}$' AND "query_runs"."outcome" IN ('SUCCESS', 'ERROR'));--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_metrics_check" CHECK (("query_runs"."duration_ms" IS NULL OR "query_runs"."duration_ms" >= 0) AND ("query_runs"."result_count" IS NULL OR "query_runs"."result_count" >= 0) AND ("query_runs"."completed_at" IS NULL OR "query_runs"."completed_at" >= "query_runs"."started_at"));--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_name_check" CHECK (octet_length("saved_queries"."name") BETWEEN 1 AND 120);--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_sharing_check" CHECK ("saved_queries"."sharing" IN ('PRIVATE', 'WORKSPACE'));--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_ast_check" CHECK ("saved_queries"."ast_version" = 1 AND jsonb_typeof("saved_queries"."query_ast") = 'object' AND octet_length("saved_queries"."query_ast"::text) <= 32768 AND "saved_queries"."query_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_archive_check" CHECK (("saved_queries"."archived_at" IS NULL AND "saved_queries"."archived_by" IS NULL) OR ("saved_queries"."archived_at" IS NOT NULL AND "saved_queries"."archived_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_result_kind_check" CHECK ("search_documents"."result_kind" IN ('PERSON', 'FACT', 'ADDRESS', 'RELATIONSHIP', 'EVIDENCE'));--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_source_kind_check" CHECK ("search_documents"."source_kind" IN ('person', 'person_name', 'fact_definition', 'fact', 'relationship_type', 'relationship', 'source', 'person_address', 'evidence_item', 'evidence_excerpt', 'note'));--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_chunk_ordinal_check" CHECK ("search_documents"."chunk_ordinal" >= 0 AND "search_documents"."chunk_ordinal" < 64);--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_schema_version_check" CHECK ("search_documents"."document_schema_version" = 1);--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_text_bounds_check" CHECK (octet_length("search_documents"."title_text") BETWEEN 1 AND 512 AND octet_length("search_documents"."body_text") <= 8192 AND octet_length("search_documents"."display_text") BETWEEN 1 AND 8192);
