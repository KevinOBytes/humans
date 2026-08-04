CREATE TABLE "ai_citations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"evidence_item_id" uuid,
	"locator" text,
	"claim_text" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_citations_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "ai_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"encrypted_content" text NOT NULL,
	"content_hash" text NOT NULL,
	"citation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "ai_messages_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_messages_role_check" CHECK ("ai_messages"."role" IN ('system', 'user', 'assistant', 'tool')),
	CONSTRAINT "ai_messages_citation_count_check" CHECK ("ai_messages"."citation_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"thread_id" uuid NOT NULL,
	"message_id" uuid,
	"provider" text NOT NULL,
	"base_url_fingerprint" text NOT NULL,
	"model" text NOT NULL,
	"capability_profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_hash" text NOT NULL,
	"configuration_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_microunits" numeric,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"error_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "ai_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_runs_usage_check" CHECK (("ai_runs"."input_tokens" IS NULL OR "ai_runs"."input_tokens" >= 0) AND ("ai_runs"."output_tokens" IS NULL OR "ai_runs"."output_tokens" >= 0) AND ("ai_runs"."cost_microunits" IS NULL OR "ai_runs"."cost_microunits" >= 0)),
	CONSTRAINT "ai_runs_timing_check" CHECK ("ai_runs"."completed_at" IS NULL OR "ai_runs"."started_at" IS NULL OR "ai_runs"."completed_at" >= "ai_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "ai_threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"sharing" text DEFAULT 'private' NOT NULL,
	"retention_days" integer,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "ai_threads_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_threads_retention_check" CHECK ("ai_threads"."retention_days" IS NULL OR "ai_threads"."retention_days" >= 0),
	CONSTRAINT "ai_threads_version_check" CHECK ("ai_threads"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "ai_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"ai_run_id" uuid NOT NULL,
	"approved_tool_name" text NOT NULL,
	"redacted_arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redacted_result_summary" jsonb,
	"resource_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_calls_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "ai_tool_calls_name_check" CHECK ("ai_tool_calls"."approved_tool_name" ~ '^[a-z][a-z0-9_.-]*$'),
	CONSTRAINT "ai_tool_calls_timing_check" CHECK ("ai_tool_calls"."completed_at" IS NULL OR "ai_tool_calls"."started_at" IS NULL OR "ai_tool_calls"."completed_at" >= "ai_tool_calls"."started_at")
);
--> statement-breakpoint
CREATE TABLE "evidence_excerpts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"page_number" integer,
	"start_offset" integer,
	"end_offset" integer,
	"start_time_ms" integer,
	"end_time_ms" integer,
	"locator" text,
	"excerpt" text NOT NULL,
	"language" text,
	"checksum" text NOT NULL,
	"redaction_state" text DEFAULT 'clear' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "evidence_excerpts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "evidence_excerpts_page_check" CHECK ("evidence_excerpts"."page_number" IS NULL OR "evidence_excerpts"."page_number" > 0),
	CONSTRAINT "evidence_excerpts_offset_check" CHECK ("evidence_excerpts"."end_offset" IS NULL OR "evidence_excerpts"."start_offset" IS NULL OR "evidence_excerpts"."end_offset" >= "evidence_excerpts"."start_offset"),
	CONSTRAINT "evidence_excerpts_time_check" CHECK ("evidence_excerpts"."end_time_ms" IS NULL OR "evidence_excerpts"."start_time_ms" IS NULL OR "evidence_excerpts"."end_time_ms" >= "evidence_excerpts"."start_time_ms")
);
--> statement-breakpoint
CREATE TABLE "evidence_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"file_id" uuid,
	"external_locator" text,
	"extracted_text" text,
	"captured_at" timestamp (3) with time zone,
	"checksum" text NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "evidence_items_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "evidence_items_version_check" CHECK ("evidence_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "fact_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"excerpt" text,
	"locator" text,
	"support_strength" numeric(4, 3),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "fact_evidence_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "fact_evidence_workspace_pair_unique" UNIQUE("workspace_id","fact_id","evidence_item_id"),
	CONSTRAINT "fact_evidence_support_check" CHECK ("fact_evidence"."support_strength" IS NULL OR "fact_evidence"."support_strength" BETWEEN -1 AND 1)
);
--> statement-breakpoint
CREATE TABLE "fact_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "fact_tags_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "fact_tags_workspace_pair_unique" UNIQUE("workspace_id","fact_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid,
	"fact_id" uuid,
	"relationship_id" uuid,
	"evidence_item_id" uuid,
	"plain_text" text,
	"sanitized_markdown" text,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "notes_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "notes_content_check" CHECK (num_nonnulls("notes"."plain_text", "notes"."sanitized_markdown") = 1),
	CONSTRAINT "notes_version_check" CHECK ("notes"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "person_addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"address_id" uuid NOT NULL,
	"address_kind" text NOT NULL,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"temporal_precision" "temporal_precision" DEFAULT 'unknown' NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"state" text DEFAULT 'asserted' NOT NULL,
	"evidence_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_addresses_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_addresses_confidence_check" CHECK ("person_addresses"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "person_addresses_validity_check" CHECK ("person_addresses"."valid_until" IS NULL OR "person_addresses"."valid_from" IS NULL OR "person_addresses"."valid_until" >= "person_addresses"."valid_from"),
	CONSTRAINT "person_addresses_version_check" CHECK ("person_addresses"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "person_contact_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"contact_point_id" uuid NOT NULL,
	"usage_kind" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"evidence_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_contact_points_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_contact_points_confidence_check" CHECK ("person_contact_points"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "person_contact_points_validity_check" CHECK ("person_contact_points"."valid_until" IS NULL OR "person_contact_points"."valid_from" IS NULL OR "person_contact_points"."valid_until" >= "person_contact_points"."valid_from"),
	CONSTRAINT "person_contact_points_version_check" CHECK ("person_contact_points"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "person_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "person_tags_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_tags_workspace_pair_unique" UNIQUE("workspace_id","person_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "relationship_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"evidence_item_id" uuid NOT NULL,
	"locator" text,
	"support_strength" numeric(4, 3),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "relationship_evidence_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "relationship_evidence_workspace_pair_unique" UNIQUE("workspace_id","relationship_id","evidence_item_id"),
	CONSTRAINT "relationship_evidence_support_check" CHECK ("relationship_evidence"."support_strength" IS NULL OR "relationship_evidence"."support_strength" BETWEEN -1 AND 1)
);
--> statement-breakpoint
CREATE TABLE "relationship_tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"relationship_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "relationship_tags_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "relationship_tags_workspace_pair_unique" UNIQUE("workspace_id","relationship_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"publisher" text,
	"author" text,
	"canonical_url" text,
	"citation" text,
	"collection_method" text,
	"collected_at" timestamp (3) with time zone,
	"reliability" numeric(4, 3),
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "sources_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "sources_reliability_check" CHECK ("sources"."reliability" IS NULL OR "sources"."reliability" BETWEEN 0 AND 1),
	CONSTRAINT "sources_version_check" CHECK ("sources"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"color" text,
	"description" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "tags_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "tags_workspace_normalized_name_unique" UNIQUE("workspace_id","normalized_name"),
	CONSTRAINT "tags_version_check" CHECK ("tags"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "extraction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"extractor" text NOT NULL,
	"extractor_version" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"structured_output" jsonb,
	"error_summary" jsonb,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "extraction_runs_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "file_variants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"parent_file_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"media_type" text,
	"byte_size" bigint,
	"checksum" text NOT NULL,
	"generator_version" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "file_variants_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "file_variants_workspace_kind_unique" UNIQUE("workspace_id","parent_file_id","kind"),
	CONSTRAINT "file_variants_byte_size_check" CHECK ("file_variants"."byte_size" IS NULL OR "file_variants"."byte_size" >= 0)
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"storage_provider" text NOT NULL,
	"storage_bucket" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"media_type" text,
	"detected_type" text,
	"byte_size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"encryption_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quarantine_state" text DEFAULT 'pending' NOT NULL,
	"scan_state" text DEFAULT 'pending' NOT NULL,
	"ocr_state" text DEFAULT 'pending' NOT NULL,
	"extraction_state" text DEFAULT 'pending' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"uploaded_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "files_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "files_workspace_storage_key_unique" UNIQUE("workspace_id","storage_provider","storage_bucket","storage_key"),
	CONSTRAINT "files_byte_size_check" CHECK ("files"."byte_size" >= 0),
	CONSTRAINT "files_version_check" CHECK ("files"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"format" text NOT NULL,
	"column_mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"validation_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "import_mappings_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "import_mappings_workspace_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "import_mappings_version_check" CHECK ("import_mappings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"import_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"source_hash" text NOT NULL,
	"normalized_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"validation_errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "import_rows_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "import_rows_workspace_row_unique" UNIQUE("workspace_id","import_id","row_number"),
	CONSTRAINT "import_rows_row_number_check" CHECK ("import_rows"."row_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"format" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"accepted_rows" integer DEFAULT 0 NOT NULL,
	"rejected_rows" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "imports_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "imports_workspace_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "imports_totals_check" CHECK ("imports"."total_rows" >= 0 AND "imports"."accepted_rows" >= 0 AND "imports"."rejected_rows" >= 0 AND "imports"."accepted_rows" + "imports"."rejected_rows" <= "imports"."total_rows"),
	CONSTRAINT "imports_version_check" CHECK ("imports"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"intended_purpose" text NOT NULL,
	"max_bytes" bigint NOT NULL,
	"expected_checksum" text,
	"expected_media_type" text,
	"object_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"file_id" uuid,
	"failure_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "upload_sessions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "upload_sessions_workspace_object_key_unique" UNIQUE("workspace_id","object_key"),
	CONSTRAINT "upload_sessions_max_bytes_check" CHECK ("upload_sessions"."max_bytes" > 0)
);
--> statement-breakpoint
CREATE TABLE "analysis_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"analysis_run_id" uuid NOT NULL,
	"result_kind" text NOT NULL,
	"subject_person_id" uuid,
	"subject_relationship_id" uuid,
	"numeric_value" numeric,
	"text_value" text,
	"json_value" jsonb,
	"rank" integer,
	"explanation" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_results_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "analysis_results_subject_check" CHECK (num_nonnulls("analysis_results"."subject_person_id", "analysis_results"."subject_relationship_id") <= 1),
	CONSTRAINT "analysis_results_value_check" CHECK (num_nonnulls("analysis_results"."numeric_value", "analysis_results"."text_value", "analysis_results"."json_value") = 1),
	CONSTRAINT "analysis_results_rank_check" CHECK ("analysis_results"."rank" IS NULL OR "analysis_results"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "analysis_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"algorithm" text NOT NULL,
	"graph_snapshot_id" uuid NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"error_summary" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "analysis_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "analysis_runs_timing_check" CHECK ("analysis_runs"."completed_at" IS NULL OR "analysis_runs"."started_at" IS NULL OR "analysis_runs"."completed_at" >= "analysis_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "graph_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"graph_view_id" uuid,
	"query_input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"included_person_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"included_relationship_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"algorithm_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "graph_snapshots_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "graph_view_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"graph_view_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"position_x" numeric,
	"position_y" numeric,
	"style_override" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"visibility" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "graph_view_nodes_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "graph_view_nodes_workspace_view_person_unique" UNIQUE("workspace_id","graph_view_id","person_id"),
	CONSTRAINT "graph_view_nodes_position_check" CHECK (("graph_view_nodes"."position_x" IS NULL AND "graph_view_nodes"."position_y" IS NULL) OR ("graph_view_nodes"."position_x" IS NOT NULL AND "graph_view_nodes"."position_y" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "graph_views" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"filters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"layout" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"appearance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sharing" text DEFAULT 'private' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "graph_views_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "graph_views_workspace_owner_name_unique" UNIQUE("workspace_id","owner_id","name"),
	CONSTRAINT "graph_views_version_check" CHECK ("graph_views"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "person_metrics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"graph_snapshot_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"metric_key" text NOT NULL,
	"metric_value" numeric NOT NULL,
	"rank" integer,
	"algorithm_version" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_metrics_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_metrics_workspace_metric_unique" UNIQUE("workspace_id","graph_snapshot_id","person_id","metric_key","algorithm_version"),
	CONSTRAINT "person_metrics_rank_check" CHECK ("person_metrics"."rank" IS NULL OR "person_metrics"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE "addresses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"place_id" uuid,
	"line1" text,
	"line2" text,
	"locality" text,
	"region" text,
	"postal_code" text,
	"country_code" text,
	"unstructured_text" text,
	"postal_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"normalized_hash" text NOT NULL,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"sensitivity" "sensitivity" DEFAULT 'confidential' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "addresses_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "addresses_value_check" CHECK (num_nonnulls("addresses"."line1", "addresses"."unstructured_text") > 0),
	CONSTRAINT "addresses_coordinates_check" CHECK (("addresses"."latitude" IS NULL AND "addresses"."longitude" IS NULL) OR ("addresses"."latitude" BETWEEN -90 AND 90 AND "addresses"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "addresses_version_check" CHECK ("addresses"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "contact_points" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"encrypted_display_value" text NOT NULL,
	"blind_index" text NOT NULL,
	"label" text,
	"verification_state" text DEFAULT 'unverified' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'confidential' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "contact_points_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "contact_points_protected_value_check" CHECK ("contact_points"."encrypted_display_value" <> '' AND "contact_points"."blind_index" <> ''),
	CONSTRAINT "contact_points_version_check" CHECK ("contact_points"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"parent_place_id" uuid,
	"country_code" text,
	"region" text,
	"locality" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"geocode_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "places_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "places_coordinates_check" CHECK (("places"."latitude" IS NULL AND "places"."longitude" IS NULL) OR ("places"."latitude" BETWEEN -90 AND 90 AND "places"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "places_parent_self_check" CHECK ("places"."parent_place_id" IS NULL OR "places"."parent_place_id" <> "places"."id"),
	CONSTRAINT "places_version_check" CHECK ("places"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text,
	"session_id" text,
	"api_key_id" text,
	"action" text NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid,
	"request_id" text NOT NULL,
	"ip_hash" text,
	"user_agent_summary" text,
	"redacted_diff" jsonb,
	"outcome" text NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "audit_events_actor_check" CHECK (num_nonnulls("audit_events"."actor_id", "audit_events"."session_id", "audit_events"."api_key_id") <= 1)
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"operation" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_reference" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "idempotency_keys_workspace_key_unique" UNIQUE("workspace_id","actor_id","operation","key_hash")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp (3) with time zone,
	"error_code" text,
	"result_references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "jobs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "jobs_workspace_idempotency_unique" UNIQUE("workspace_id","kind","idempotency_key"),
	CONSTRAINT "jobs_attempt_count_check" CHECK ("jobs"."attempt_count" >= 0),
	CONSTRAINT "jobs_lease_check" CHECK (("jobs"."lease_owner" IS NULL AND "jobs"."lease_expires_at" IS NULL) OR ("jobs"."lease_owner" IS NOT NULL AND "jobs"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"signature_algorithm" text NOT NULL,
	"signature_key_id" text,
	"response_status" integer,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"next_retry_at" timestamp (3) with time zone,
	"redacted_error" jsonb,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhook_deliveries_workspace_attempt_unique" UNIQUE("workspace_id","webhook_id","event_id","attempt"),
	CONSTRAINT "webhook_deliveries_attempt_check" CHECK ("webhook_deliveries"."attempt" > 0),
	CONSTRAINT "webhook_deliveries_status_check" CHECK ("webhook_deliveries"."response_status" IS NULL OR "webhook_deliveries"."response_status" BETWEEN 100 AND 599),
	CONSTRAINT "webhook_deliveries_timing_check" CHECK ("webhook_deliveries"."completed_at" IS NULL OR "webhook_deliveries"."started_at" IS NULL OR "webhook_deliveries"."completed_at" >= "webhook_deliveries"."started_at")
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"encrypted_secret" text NOT NULL,
	"secret_fingerprint" text NOT NULL,
	"subscribed_events" text[] NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "webhooks_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhooks_workspace_url_unique" UNIQUE("workspace_id","url"),
	CONSTRAINT "webhooks_url_check" CHECK ("webhooks"."url" ~ '^https://'),
	CONSTRAINT "webhooks_events_check" CHECK (cardinality("webhooks"."subscribed_events") > 0),
	CONSTRAINT "webhooks_version_check" CHECK ("webhooks"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "relationship_types" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"namespace" text DEFAULT 'workspace' NOT NULL,
	"key" text NOT NULL,
	"forward_label" text NOT NULL,
	"inverse_label" text NOT NULL,
	"directed" boolean DEFAULT true NOT NULL,
	"allows_self" boolean DEFAULT false NOT NULL,
	"allowed_multiplicity" text DEFAULT 'many_to_many' NOT NULL,
	"metadata_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "lifecycle_state" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "relationship_types_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "relationship_types_workspace_key_unique" UNIQUE("workspace_id","namespace","key"),
	CONSTRAINT "relationship_types_version_check" CHECK ("relationship_types"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_person_id" uuid NOT NULL,
	"target_person_id" uuid NOT NULL,
	"relationship_type_id" uuid NOT NULL,
	"label_override" text,
	"strength" numeric(4, 3),
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"state" text DEFAULT 'asserted' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"temporal_semantics" "temporal_semantics" DEFAULT 'unknown' NOT NULL,
	"temporal_precision" "temporal_precision" DEFAULT 'unknown' NOT NULL,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "relationships_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "relationships_strength_check" CHECK ("relationships"."strength" IS NULL OR "relationships"."strength" BETWEEN 0 AND 1),
	CONSTRAINT "relationships_confidence_check" CHECK ("relationships"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "relationships_validity_check" CHECK ("relationships"."valid_until" IS NULL OR "relationships"."valid_from" IS NULL OR "relationships"."valid_until" >= "relationships"."valid_from"),
	CONSTRAINT "relationships_version_check" CHECK ("relationships"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"dimensions" integer NOT NULL,
	"vector_json" jsonb NOT NULL,
	"source_hash" text NOT NULL,
	"configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embeddings_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "embeddings_workspace_resource_model_unique" UNIQUE("workspace_id","resource_kind","resource_id","provider","model","source_hash"),
	CONSTRAINT "embeddings_dimensions_check" CHECK ("embeddings"."dimensions" > 0 AND jsonb_typeof("embeddings"."vector_json") = 'array' AND jsonb_array_length("embeddings"."vector_json") = "embeddings"."dimensions")
);
--> statement-breakpoint
CREATE TABLE "query_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"saved_query_id" uuid,
	"actor_id" text NOT NULL,
	"normalized_input_hash" text NOT NULL,
	"started_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	"duration_ms" integer,
	"result_count" integer,
	"redacted_error_metadata" jsonb,
	CONSTRAINT "query_runs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "query_runs_metrics_check" CHECK (("query_runs"."duration_ms" IS NULL OR "query_runs"."duration_ms" >= 0) AND ("query_runs"."result_count" IS NULL OR "query_runs"."result_count" >= 0))
);
--> statement-breakpoint
CREATE TABLE "saved_queries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"graphql_document" text,
	"structured_filter" jsonb,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sharing" text DEFAULT 'private' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "saved_queries_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "saved_queries_workspace_owner_name_unique" UNIQUE("workspace_id","owner_id","name"),
	CONSTRAINT "saved_queries_definition_check" CHECK (num_nonnulls("saved_queries"."graphql_document", "saved_queries"."structured_filter") = 1),
	CONSTRAINT "saved_queries_version_check" CHECK ("saved_queries"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "search_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"redacted_text" text NOT NULL,
	"search_vector" tsvector,
	"source_version" integer NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_documents_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "search_documents_workspace_resource_unique" UNIQUE("workspace_id","resource_kind","resource_id"),
	CONSTRAINT "search_documents_source_version_check" CHECK ("search_documents"."source_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_run_fk" FOREIGN KEY ("workspace_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."ai_messages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_item_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_workspace_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."ai_threads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_thread_fk" FOREIGN KEY ("workspace_id","thread_id") REFERENCES "public"."ai_threads"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_workspace_message_fk" FOREIGN KEY ("workspace_id","message_id") REFERENCES "public"."ai_messages"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_threads" ADD CONSTRAINT "ai_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_workspace_run_fk" FOREIGN KEY ("workspace_id","ai_run_id") REFERENCES "public"."ai_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_excerpts" ADD CONSTRAINT "evidence_excerpts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_excerpts" ADD CONSTRAINT "evidence_excerpts_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_item_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_workspace_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."sources"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_items" ADD CONSTRAINT "evidence_items_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_workspace_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_evidence" ADD CONSTRAINT "fact_evidence_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_item_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_tags" ADD CONSTRAINT "fact_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_tags" ADD CONSTRAINT "fact_tags_workspace_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_tags" ADD CONSTRAINT "fact_tags_workspace_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tags"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_relationship_fk" FOREIGN KEY ("workspace_id","relationship_id") REFERENCES "public"."relationships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_item_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_workspace_address_fk" FOREIGN KEY ("workspace_id","address_id") REFERENCES "public"."addresses"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_addresses" ADD CONSTRAINT "person_addresses_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contact_points" ADD CONSTRAINT "person_contact_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contact_points" ADD CONSTRAINT "person_contact_points_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contact_points" ADD CONSTRAINT "person_contact_points_workspace_contact_fk" FOREIGN KEY ("workspace_id","contact_point_id") REFERENCES "public"."contact_points"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_contact_points" ADD CONSTRAINT "person_contact_points_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_tags" ADD CONSTRAINT "person_tags_workspace_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tags"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_evidence" ADD CONSTRAINT "relationship_evidence_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_evidence" ADD CONSTRAINT "relationship_evidence_workspace_relationship_fk" FOREIGN KEY ("workspace_id","relationship_id") REFERENCES "public"."relationships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_evidence" ADD CONSTRAINT "relationship_evidence_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_item_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_tags" ADD CONSTRAINT "relationship_tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_tags" ADD CONSTRAINT "relationship_tags_workspace_relationship_fk" FOREIGN KEY ("workspace_id","relationship_id") REFERENCES "public"."relationships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_tags" ADD CONSTRAINT "relationship_tags_workspace_tag_fk" FOREIGN KEY ("workspace_id","tag_id") REFERENCES "public"."tags"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_runs" ADD CONSTRAINT "extraction_runs_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_variants" ADD CONSTRAINT "file_variants_workspace_parent_file_fk" FOREIGN KEY ("workspace_id","parent_file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_mappings" ADD CONSTRAINT "import_mappings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_workspace_import_fk" FOREIGN KEY ("workspace_id","import_id") REFERENCES "public"."imports"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_run_fk" FOREIGN KEY ("workspace_id","analysis_run_id") REFERENCES "public"."analysis_runs"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_person_fk" FOREIGN KEY ("workspace_id","subject_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_results" ADD CONSTRAINT "analysis_results_workspace_relationship_fk" FOREIGN KEY ("workspace_id","subject_relationship_id") REFERENCES "public"."relationships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_runs" ADD CONSTRAINT "analysis_runs_workspace_snapshot_fk" FOREIGN KEY ("workspace_id","graph_snapshot_id") REFERENCES "public"."graph_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_snapshots" ADD CONSTRAINT "graph_snapshots_workspace_view_fk" FOREIGN KEY ("workspace_id","graph_view_id") REFERENCES "public"."graph_views"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_view_nodes" ADD CONSTRAINT "graph_view_nodes_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_view_nodes" ADD CONSTRAINT "graph_view_nodes_workspace_view_fk" FOREIGN KEY ("workspace_id","graph_view_id") REFERENCES "public"."graph_views"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_view_nodes" ADD CONSTRAINT "graph_view_nodes_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "graph_views" ADD CONSTRAINT "graph_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_metrics" ADD CONSTRAINT "person_metrics_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_metrics" ADD CONSTRAINT "person_metrics_workspace_snapshot_fk" FOREIGN KEY ("workspace_id","graph_snapshot_id") REFERENCES "public"."graph_snapshots"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_metrics" ADD CONSTRAINT "person_metrics_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_workspace_place_fk" FOREIGN KEY ("workspace_id","place_id") REFERENCES "public"."places"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_workspace_parent_fk" FOREIGN KEY ("workspace_id","parent_place_id") REFERENCES "public"."places"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_webhook_fk" FOREIGN KEY ("workspace_id","webhook_id") REFERENCES "public"."webhooks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationship_types" ADD CONSTRAINT "relationship_types_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_source_person_fk" FOREIGN KEY ("workspace_id","source_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_target_person_fk" FOREIGN KEY ("workspace_id","target_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_type_fk" FOREIGN KEY ("workspace_id","relationship_type_id") REFERENCES "public"."relationship_types"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_runs" ADD CONSTRAINT "query_runs_workspace_saved_query_fk" FOREIGN KEY ("workspace_id","saved_query_id") REFERENCES "public"."saved_queries"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_queries" ADD CONSTRAINT "saved_queries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_citations_workspace_run_idx" ON "ai_citations" USING btree ("workspace_id","ai_run_id","message_id");--> statement-breakpoint
CREATE INDEX "ai_messages_workspace_thread_idx" ON "ai_messages" USING btree ("workspace_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_runs_workspace_thread_idx" ON "ai_runs" USING btree ("workspace_id","thread_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_threads_workspace_owner_idx" ON "ai_threads" USING btree ("workspace_id","owner_id","updated_at");--> statement-breakpoint
CREATE INDEX "ai_tool_calls_workspace_run_idx" ON "ai_tool_calls" USING btree ("workspace_id","ai_run_id","created_at");--> statement-breakpoint
CREATE INDEX "evidence_excerpts_workspace_evidence_idx" ON "evidence_excerpts" USING btree ("workspace_id","evidence_item_id");--> statement-breakpoint
CREATE INDEX "evidence_items_workspace_source_idx" ON "evidence_items" USING btree ("workspace_id","source_id");--> statement-breakpoint
CREATE INDEX "notes_workspace_person_idx" ON "notes" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "person_addresses_workspace_person_idx" ON "person_addresses" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "person_contact_points_workspace_person_idx" ON "person_contact_points" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "sources_workspace_content_hash_idx" ON "sources" USING btree ("workspace_id","content_hash");--> statement-breakpoint
CREATE INDEX "extraction_runs_workspace_file_idx" ON "extraction_runs" USING btree ("workspace_id","file_id","created_at");--> statement-breakpoint
CREATE INDEX "files_workspace_checksum_idx" ON "files" USING btree ("workspace_id","checksum");--> statement-breakpoint
CREATE INDEX "files_workspace_quarantine_idx" ON "files" USING btree ("workspace_id","quarantine_state","scan_state");--> statement-breakpoint
CREATE INDEX "analysis_results_workspace_run_idx" ON "analysis_results" USING btree ("workspace_id","analysis_run_id","rank");--> statement-breakpoint
CREATE INDEX "analysis_runs_workspace_snapshot_idx" ON "analysis_runs" USING btree ("workspace_id","graph_snapshot_id","created_at");--> statement-breakpoint
CREATE INDEX "graph_snapshots_workspace_view_idx" ON "graph_snapshots" USING btree ("workspace_id","graph_view_id","generated_at");--> statement-breakpoint
CREATE INDEX "addresses_workspace_hash_idx" ON "addresses" USING btree ("workspace_id","normalized_hash");--> statement-breakpoint
CREATE INDEX "contact_points_workspace_blind_index_idx" ON "contact_points" USING btree ("workspace_id","kind","blind_index");--> statement-breakpoint
CREATE INDEX "places_workspace_name_idx" ON "places" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_resource_idx" ON "audit_events" USING btree ("workspace_id","resource_kind","resource_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_request_idx" ON "audit_events" USING btree ("workspace_id","request_id");--> statement-breakpoint
CREATE INDEX "idempotency_keys_workspace_expiry_idx" ON "idempotency_keys" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "jobs_workspace_claim_idx" ON "jobs" USING btree ("workspace_id","state","priority","scheduled_at");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_retry_idx" ON "webhook_deliveries" USING btree ("workspace_id","next_retry_at");--> statement-breakpoint
CREATE INDEX "relationships_workspace_source_idx" ON "relationships" USING btree ("workspace_id","source_person_id");--> statement-breakpoint
CREATE INDEX "relationships_workspace_target_idx" ON "relationships" USING btree ("workspace_id","target_person_id");--> statement-breakpoint
CREATE INDEX "embeddings_workspace_resource_idx" ON "embeddings" USING btree ("workspace_id","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "query_runs_workspace_query_idx" ON "query_runs" USING btree ("workspace_id","saved_query_id","started_at");--> statement-breakpoint
CREATE INDEX "search_documents_workspace_resource_idx" ON "search_documents" USING btree ("workspace_id","resource_kind","resource_id");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_place_fk" FOREIGN KEY ("workspace_id","place_id") REFERENCES "public"."places"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_workspace_import_fk" FOREIGN KEY ("workspace_id","import_id") REFERENCES "public"."imports"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_primary_photo_fk" FOREIGN KEY ("workspace_id","primary_photo_file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_events" ADD CONSTRAINT "person_events_workspace_place_fk" FOREIGN KEY ("workspace_id","place_id") REFERENCES "public"."places"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_workspace_export_fk" FOREIGN KEY ("workspace_id","export_reference_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.enforce_relationship_self_policy()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source_person_id = NEW.target_person_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.relationship_types
      WHERE workspace_id = NEW.workspace_id
        AND id = NEW.relationship_type_id
        AND allows_self = true
    )
  THEN
    RAISE EXCEPTION 'relationship type does not allow self relationships'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER relationships_self_policy_trigger
BEFORE INSERT OR UPDATE OF workspace_id, source_person_id, target_person_id, relationship_type_id
ON public.relationships
FOR EACH ROW
EXECUTE FUNCTION public.enforce_relationship_self_policy();
