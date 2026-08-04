ALTER TABLE "analysis_results" DROP CONSTRAINT "analysis_results_payload_check";--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_contract_check";--> statement-breakpoint
ALTER TABLE "analysis_runs" DROP CONSTRAINT "analysis_runs_timing_check";--> statement-breakpoint
ALTER TABLE "graph_snapshots" DROP CONSTRAINT "graph_snapshots_manifest_check";--> statement-breakpoint
ALTER TABLE "graph_snapshots" DROP CONSTRAINT "graph_snapshots_manifest_material_check";--> statement-breakpoint
ALTER TABLE "analysis_results" DROP CONSTRAINT "analysis_results_workspace_run_fk";
--> statement-breakpoint
ALTER TABLE "analysis_results" DROP CONSTRAINT "analysis_results_workspace_person_fk";
--> statement-breakpoint
ALTER TABLE "analysis_results" DROP CONSTRAINT "analysis_results_workspace_relationship_fk";
--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_run_fk" FOREIGN KEY ("workspace_id","analysis_run_id") REFERENCES "public"."analysis_runs"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_person_fk" FOREIGN KEY ("workspace_id","subject_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_relationship_fk" FOREIGN KEY ("workspace_id","subject_relationship_id") REFERENCES "public"."relationships"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_payload_check" CHECK ("analysis_results"."payload_schema" = 'humans.graph-analysis-result.v1'
        AND "analysis_results"."payload_hash" ~ '^[0-9a-f]{64}$'
        AND "analysis_results"."result_kind" IN ('degree', 'pagerank', 'community')
        AND octet_length("analysis_results"."export_label") BETWEEN 1 AND 120
        AND ("analysis_results"."text_value" IS NULL OR octet_length("analysis_results"."text_value") <= 8192)
        AND ("analysis_results"."json_value" IS NULL OR octet_length("analysis_results"."json_value"::text) <= 32768)
        AND ("analysis_results"."explanation" IS NULL OR octet_length("analysis_results"."explanation") <= 1024));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_contract_check" CHECK ("analysis_runs"."configuration_hash" ~ '^[0-9a-f]{64}$'
        AND "analysis_runs"."actor_kind" IN ('USER', 'API_KEY')
        AND "analysis_runs"."algorithm" IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY')
        AND octet_length("analysis_runs"."algorithm_version") BETWEEN 1 AND 256
        AND jsonb_typeof("analysis_runs"."configuration") = 'object'
        AND "analysis_runs"."configuration" <> '{}'::jsonb
        AND octet_length("analysis_runs"."configuration"::text) <= 32768
        AND "analysis_runs"."state" IN ('pending', 'running', 'completed', 'failed', 'cancelled')
        AND ("analysis_runs"."error_summary" IS NULL OR (
          jsonb_typeof("analysis_runs"."error_summary") = 'object'
          AND octet_length("analysis_runs"."error_summary"::text) <= 32768
        )));--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_timing_check" CHECK ((
          "analysis_runs"."state" IN ('pending', 'running')
          AND "analysis_runs"."completed_at" IS NULL
        ) OR (
          "analysis_runs"."state" IN ('completed', 'failed', 'cancelled')
          AND "analysis_runs"."started_at" IS NOT NULL
          AND "analysis_runs"."completed_at" IS NOT NULL
          AND "analysis_runs"."completed_at" >= "analysis_runs"."started_at"
        ));--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_manifest_check" CHECK ("graph_snapshots"."manifest_schema" = 'humans.graph-snapshot-manifest.v1'
        AND "graph_snapshots"."manifest_hash" ~ '^[0-9a-f]{64}$'
        AND "graph_snapshots"."query_hash" ~ '^[0-9a-f]{64}$'
        AND "graph_snapshots"."authorization_hash" ~ '^[0-9a-f]{64}$'
        AND "graph_snapshots"."algorithm_config_hash" ~ '^[0-9a-f]{64}$'
        AND "graph_snapshots"."actor_kind" IN ('USER', 'API_KEY')
        AND "graph_snapshots"."algorithm" IN ('DEGREE', 'PAGERANK', 'LOUVAIN_COMMUNITY')
        AND octet_length("graph_snapshots"."algorithm_version") BETWEEN 1 AND 256
        AND jsonb_typeof("graph_snapshots"."query_input") = 'object'
        AND octet_length("graph_snapshots"."query_input"::text) <= 32768
        AND jsonb_typeof("graph_snapshots"."included_person_versions") = 'object'
        AND octet_length("graph_snapshots"."included_person_versions"::text) <= 2000000
        AND jsonb_typeof("graph_snapshots"."included_relationship_versions") = 'object'
        AND octet_length("graph_snapshots"."included_relationship_versions"::text) <= 2000000
        AND jsonb_typeof("graph_snapshots"."included_relationship_type_versions") = 'object'
        AND octet_length("graph_snapshots"."included_relationship_type_versions"::text) <= 2000000
        AND jsonb_typeof("graph_snapshots"."algorithm_configuration") = 'object'
        AND "graph_snapshots"."algorithm_configuration" <> '{}'::jsonb
        AND octet_length("graph_snapshots"."algorithm_configuration"::text) <= 32768
        AND jsonb_typeof("graph_snapshots"."runtime_contract") = 'object'
        AND "graph_snapshots"."runtime_contract" <> '{}'::jsonb
        AND octet_length("graph_snapshots"."runtime_contract"::text) <= 32768);--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_manifest_material_check" CHECK (jsonb_typeof("graph_snapshots"."manifest_material") = 'object'
        AND "graph_snapshots"."manifest_material" <> '{}'::jsonb
        AND octet_length("graph_snapshots"."manifest_material"::text) <= 33554432);--> statement-breakpoint
DROP TRIGGER IF EXISTS analysis_results_immutable_trigger ON analysis_results;--> statement-breakpoint
CREATE OR REPLACE FUNCTION task12_correction_enforce_analysis_result_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_state text;
  parent_completed_at timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT run.state, run.completed_at
      INTO parent_state, parent_completed_at
      FROM analysis_runs run
      WHERE run.workspace_id = NEW.workspace_id
        AND run.id = NEW.analysis_run_id
      FOR UPDATE;
    IF NOT FOUND
      OR parent_state IS DISTINCT FROM 'running'
      OR parent_completed_at IS NOT NULL
    THEN
      RAISE EXCEPTION 'analysis results may only be inserted while their run is active'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'analysis results are immutable after insertion'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER analysis_results_lifecycle_trigger
BEFORE INSERT OR UPDATE OR DELETE ON analysis_results
FOR EACH ROW EXECUTE FUNCTION task12_correction_enforce_analysis_result_lifecycle();--> statement-breakpoint
CREATE OR REPLACE FUNCTION task12_correction_enforce_analysis_run_finalize()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.state = 'running'
    AND OLD.completed_at IS NULL
    AND NEW.state = 'completed'
    AND NEW.completed_at IS NOT NULL
    AND (to_jsonb(OLD) - 'state' - 'completed_at') =
        (to_jsonb(NEW) - 'state' - 'completed_at')
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'analysis run lifecycle is immutable outside finalization'
    USING ERRCODE = '23514';
END;
$$;--> statement-breakpoint
CREATE TRIGGER analysis_runs_finalize_only_trigger
BEFORE UPDATE ON analysis_runs
FOR EACH ROW EXECUTE FUNCTION task12_correction_enforce_analysis_run_finalize();
