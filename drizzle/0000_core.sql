CREATE TYPE "public"."consent_status" AS ENUM('granted', 'denied', 'withdrawn', 'expired', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."deletion_behavior" AS ENUM('review', 'soft_delete', 'hard_delete', 'anonymize');--> statement-breakpoint
CREATE TYPE "public"."deletion_request_state" AS ENUM('requested', 'reviewing', 'approved', 'rejected', 'exporting', 'deleting', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."fact_cardinality" AS ENUM('one', 'many');--> statement-breakpoint
CREATE TYPE "public"."fact_definition_state" AS ENUM('draft', 'active', 'deprecated', 'archived');--> statement-breakpoint
CREATE TYPE "public"."fact_relationship_type" AS ENUM('supports', 'contradicts', 'duplicates', 'supersedes', 'derived_from');--> statement-breakpoint
CREATE TYPE "public"."fact_review_state" AS ENUM('unreviewed', 'in_review', 'accepted', 'rejected', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."fact_state" AS ENUM('asserted', 'corroborated', 'disputed', 'disproven', 'superseded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."fact_value_type" AS ENUM('text', 'rich_text', 'integer', 'decimal', 'boolean', 'date', 'date_range', 'timestamp', 'duration', 'quantity', 'uri', 'json', 'person_reference', 'place_reference', 'file_reference');--> statement-breakpoint
CREATE TYPE "public"."identifier_verification_state" AS ENUM('unverified', 'verified', 'disputed', 'revoked', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."legal_hold_state" AS ENUM('active', 'released');--> statement-breakpoint
CREATE TYPE "public"."lifecycle_state" AS ENUM('active', 'inactive', 'archived');--> statement-breakpoint
CREATE TYPE "public"."merge_candidate_state" AS ENUM('pending', 'reviewing', 'accepted', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."person_name_kind" AS ENUM('legal', 'preferred', 'birth', 'married', 'former', 'alias', 'transliteration', 'other');--> statement-breakpoint
CREATE TYPE "public"."person_record_state" AS ENUM('asserted', 'verified', 'disputed', 'superseded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."person_status" AS ENUM('active', 'deceased', 'missing', 'unknown', 'archived', 'merged');--> statement-breakpoint
CREATE TYPE "public"."policy_state" AS ENUM('draft', 'active', 'disabled', 'archived');--> statement-breakpoint
CREATE TYPE "public"."sensitivity" AS ENUM('public', 'internal', 'confidential', 'restricted');--> statement-breakpoint
CREATE TYPE "public"."temporal_precision" AS ENUM('instant', 'second', 'minute', 'hour', 'day', 'month', 'year', 'range', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."temporal_semantics" AS ENUM('exact', 'approximate', 'before', 'after', 'between', 'year_only', 'unknown');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp (3) with time zone,
	"refresh_token_expires_at" timestamp (3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_provider_account_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp (3) with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer DEFAULT 86400000,
	"rate_limit_max" integer DEFAULT 10,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp (3) with time zone,
	"expires_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone NOT NULL,
	"updated_at" timestamp (3) with time zone NOT NULL,
	"permissions" text,
	"metadata" text,
	CONSTRAINT "api_keys_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp (3) with time zone NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "members_organization_user_unique" UNIQUE("organization_id","user_id"),
	CONSTRAINT "members_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp (3) with time zone NOT NULL,
	"metadata" text,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	"active_organization_id" text,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failed_verification_count" integer DEFAULT 0,
	"locked_until" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"two_factor_enabled" boolean DEFAULT false,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp (3) with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"category" text,
	"allowed_value_type" "fact_value_type" NOT NULL,
	"cardinality" "fact_cardinality" DEFAULT 'one' NOT NULL,
	"validation_schema" jsonb,
	"enumeration_metadata" jsonb,
	"searchable" boolean DEFAULT false NOT NULL,
	"filterable" boolean DEFAULT false NOT NULL,
	"graphable" boolean DEFAULT false NOT NULL,
	"user_definable" boolean DEFAULT true NOT NULL,
	"default_sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"state" "fact_definition_state" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "fact_definitions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "fact_definitions_workspace_id_type_unique" UNIQUE("workspace_id","id","allowed_value_type"),
	CONSTRAINT "fact_definitions_workspace_key_unique" UNIQUE("workspace_id","namespace","field_key"),
	CONSTRAINT "fact_definitions_version_check" CHECK ("fact_definitions"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "fact_relationships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_fact_id" uuid NOT NULL,
	"target_fact_id" uuid NOT NULL,
	"relationship_type" "fact_relationship_type" NOT NULL,
	"explanation" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "fact_relationships_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "fact_relationships_distinct_facts_check" CHECK ("fact_relationships"."source_fact_id" <> "fact_relationships"."target_fact_id"),
	CONSTRAINT "fact_relationships_version_check" CHECK ("fact_relationships"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "fact_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"fact_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"before_snapshot" jsonb,
	"after_snapshot" jsonb NOT NULL,
	"change_reason" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "fact_revisions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "fact_revisions_workspace_fact_revision_unique" UNIQUE("workspace_id","fact_id","revision"),
	CONSTRAINT "fact_revisions_revision_check" CHECK ("fact_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"fact_definition_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	"value_type" "fact_value_type" NOT NULL,
	"value_text" text,
	"value_decimal" numeric(38, 12),
	"value_boolean" boolean,
	"value_date_start" date,
	"value_date_end" date,
	"value_timestamp" timestamp (3) with time zone,
	"value_json" jsonb,
	"referenced_person_id" uuid,
	"place_id" uuid,
	"file_id" uuid,
	"unit" text,
	"language" text,
	"normalized_search_value" text,
	"encrypted_value" text,
	"blind_index" text,
	"state" "fact_state" DEFAULT 'asserted' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"confidence_method" text,
	"confidence_explanation" text,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"review_state" "fact_review_state" DEFAULT 'unreviewed' NOT NULL,
	"temporal_semantics" "temporal_semantics" DEFAULT 'unknown' NOT NULL,
	"valid_earliest_at" timestamp (3) with time zone,
	"valid_latest_at" timestamp (3) with time zone,
	"observed_at" timestamp (3) with time zone,
	"asserted_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"temporal_precision" "temporal_precision" DEFAULT 'unknown' NOT NULL,
	"supersedes_fact_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "facts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "facts_workspace_person_id_unique" UNIQUE("workspace_id","person_id","id"),
	CONSTRAINT "facts_workspace_person_field_id_unique" UNIQUE("workspace_id","person_id","namespace","field_key","id"),
	CONSTRAINT "facts_typed_value_check" CHECK (
        (
          "facts"."value_type" IN ('text', 'rich_text', 'uri')
          AND num_nonnulls("facts"."value_text", "facts"."encrypted_value") = 1
          AND num_nonnulls("facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id") = 0
        ) OR (
          "facts"."value_type" = 'integer'
          AND "facts"."value_decimal" IS NOT NULL
          AND "facts"."value_decimal" = trunc("facts"."value_decimal")
          AND num_nonnulls("facts"."value_text", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'decimal'
          AND "facts"."value_decimal" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" IN ('duration', 'quantity')
          AND "facts"."value_decimal" IS NOT NULL
          AND "facts"."unit" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'boolean'
          AND "facts"."value_boolean" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'date'
          AND "facts"."value_date_start" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'date_range'
          AND "facts"."value_date_start" IS NOT NULL
          AND "facts"."value_date_end" IS NOT NULL
          AND "facts"."value_date_end" >= "facts"."value_date_start"
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'timestamp'
          AND "facts"."value_timestamp" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'json'
          AND "facts"."value_json" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."referenced_person_id", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'person_reference'
          AND "facts"."referenced_person_id" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."place_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'place_reference'
          AND "facts"."place_id" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."file_id", "facts"."encrypted_value") = 0
        ) OR (
          "facts"."value_type" = 'file_reference'
          AND "facts"."file_id" IS NOT NULL
          AND num_nonnulls("facts"."value_text", "facts"."value_decimal", "facts"."value_boolean", "facts"."value_date_start", "facts"."value_date_end", "facts"."value_timestamp", "facts"."value_json", "facts"."referenced_person_id", "facts"."place_id", "facts"."encrypted_value") = 0
        )
      ),
	CONSTRAINT "facts_encrypted_blind_index_check" CHECK ("facts"."encrypted_value" IS NULL OR "facts"."blind_index" IS NOT NULL),
	CONSTRAINT "facts_unit_check" CHECK (("facts"."value_type" IN ('duration', 'quantity') AND "facts"."unit" IS NOT NULL)
        OR ("facts"."value_type" NOT IN ('duration', 'quantity') AND "facts"."unit" IS NULL)),
	CONSTRAINT "facts_confidence_check" CHECK ("facts"."confidence" >= 0 AND "facts"."confidence" <= 1),
	CONSTRAINT "facts_validity_check" CHECK ("facts"."valid_latest_at" IS NULL OR "facts"."valid_earliest_at" IS NULL OR "facts"."valid_latest_at" >= "facts"."valid_earliest_at"),
	CONSTRAINT "facts_supersedes_self_check" CHECK ("facts"."supersedes_fact_id" IS NULL OR "facts"."supersedes_fact_id" <> "facts"."id"),
	CONSTRAINT "facts_version_check" CHECK ("facts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "person_field_selections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"field_key" text NOT NULL,
	"fact_id" uuid NOT NULL,
	"selected_by" text NOT NULL,
	"selection_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_field_selections_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_field_selections_version_check" CHECK ("person_field_selections"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" "consent_status" NOT NULL,
	"source" text NOT NULL,
	"effective_from" timestamp (3) with time zone NOT NULL,
	"effective_until" timestamp (3) with time zone,
	"evidence_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "consent_records_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "consent_records_effective_interval_check" CHECK ("consent_records"."effective_until" IS NULL OR "consent_records"."effective_until" >= "consent_records"."effective_from")
);
--> statement-breakpoint
CREATE TABLE "external_records" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_system" text NOT NULL,
	"external_type" text NOT NULL,
	"external_id" text NOT NULL,
	"person_id" uuid NOT NULL,
	"import_id" uuid,
	"source_hash" text,
	"last_seen_at" timestamp (3) with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "external_records_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "external_records_source_unique" UNIQUE("workspace_id","source_system","external_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "identity_candidates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"first_person_id" uuid NOT NULL,
	"second_person_id" uuid NOT NULL,
	"match_signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" numeric(4, 3) NOT NULL,
	"state" "merge_candidate_state" DEFAULT 'pending' NOT NULL,
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
	CONSTRAINT "identity_candidates_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "identity_candidates_pair_unique" UNIQUE("workspace_id","first_person_id","second_person_id"),
	CONSTRAINT "identity_candidates_people_check" CHECK ("identity_candidates"."first_person_id" <> "identity_candidates"."second_person_id"),
	CONSTRAINT "identity_candidates_score_check" CHECK ("identity_candidates"."score" >= 0 AND "identity_candidates"."score" <= 1)
);
--> statement-breakpoint
CREATE TABLE "merge_decisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"winner_person_id" uuid NOT NULL,
	"loser_person_id" uuid NOT NULL,
	"field_choices" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"reversible_snapshot" jsonb NOT NULL,
	"decided_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"decided_by" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "merge_decisions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "merge_decisions_people_check" CHECK ("merge_decisions"."winner_person_id" <> "merge_decisions"."loser_person_id")
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"sort_name" text,
	"preferred_name" text,
	"biography" text,
	"primary_name_id" uuid,
	"primary_photo_file_id" uuid,
	"status" "person_status" DEFAULT 'active' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"confidence_explanation" text,
	"merged_into_person_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "people_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "people_confidence_check" CHECK ("people"."confidence" >= 0 AND "people"."confidence" <= 1),
	CONSTRAINT "people_version_check" CHECK ("people"."version" > 0),
	CONSTRAINT "people_merge_state_check" CHECK (("people"."status" = 'merged' AND "people"."merged_into_person_id" IS NOT NULL)
        OR ("people"."status" <> 'merged' AND "people"."merged_into_person_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "person_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"place_id" uuid,
	"earliest_at" timestamp (3) with time zone,
	"latest_at" timestamp (3) with time zone,
	"temporal_semantics" "temporal_semantics" DEFAULT 'unknown' NOT NULL,
	"temporal_precision" "temporal_precision" DEFAULT 'unknown' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"state" "person_record_state" DEFAULT 'asserted' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_events_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_events_confidence_check" CHECK ("person_events"."confidence" >= 0 AND "person_events"."confidence" <= 1),
	CONSTRAINT "person_events_temporal_bounds_check" CHECK ("person_events"."latest_at" IS NULL OR "person_events"."earliest_at" IS NULL OR "person_events"."latest_at" >= "person_events"."earliest_at")
);
--> statement-breakpoint
CREATE TABLE "person_identifiers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"namespace" text NOT NULL,
	"identifier_type" text NOT NULL,
	"encrypted_raw_value" text,
	"normalized_value" text,
	"blind_index" text,
	"issuer" text,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"verification_state" "identifier_verification_state" DEFAULT 'unverified' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'confidential' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_identifiers_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_identifiers_value_check" CHECK (num_nonnulls("person_identifiers"."encrypted_raw_value", "person_identifiers"."normalized_value", "person_identifiers"."blind_index") > 0),
	CONSTRAINT "person_identifiers_validity_check" CHECK ("person_identifiers"."valid_until" IS NULL OR "person_identifiers"."valid_from" IS NULL OR "person_identifiers"."valid_until" >= "person_identifiers"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "person_names" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"kind" "person_name_kind" NOT NULL,
	"full_name" text NOT NULL,
	"given_name" text,
	"middle_name" text,
	"family_name" text,
	"prefix" text,
	"suffix" text,
	"script" text,
	"language" text,
	"normalized_form" text,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"temporal_semantics" "temporal_semantics" DEFAULT 'unknown' NOT NULL,
	"temporal_precision" "temporal_precision" DEFAULT 'unknown' NOT NULL,
	"confidence" numeric(4, 3) DEFAULT '1' NOT NULL,
	"sensitivity" "sensitivity" DEFAULT 'internal' NOT NULL,
	"state" "person_record_state" DEFAULT 'asserted' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_names_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_names_workspace_person_id_unique" UNIQUE("workspace_id","person_id","id"),
	CONSTRAINT "person_names_confidence_check" CHECK ("person_names"."confidence" >= 0 AND "person_names"."confidence" <= 1),
	CONSTRAINT "person_names_validity_check" CHECK ("person_names"."valid_until" IS NULL OR "person_names"."valid_from" IS NULL OR "person_names"."valid_until" >= "person_names"."valid_from"),
	CONSTRAINT "person_names_version_check" CHECK ("person_names"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "access_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sensitivity_ceiling" "sensitivity" DEFAULT 'restricted' NOT NULL,
	"resource_kinds" text[] DEFAULT '{}' NOT NULL,
	"role_bindings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state" "policy_state" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "access_policies_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "access_policies_workspace_name_unique" UNIQUE("workspace_id","name"),
	CONSTRAINT "access_policies_version_check" CHECK ("access_policies"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"requester_id" text NOT NULL,
	"scope" jsonb NOT NULL,
	"state" "deletion_request_state" DEFAULT 'requested' NOT NULL,
	"reviewed_at" timestamp (3) with time zone,
	"reviewed_by" text,
	"review_notes" text,
	"export_reference_id" uuid,
	"completed_at" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "deletion_requests_workspace_id_unique" UNIQUE("workspace_id","id")
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"reason" text NOT NULL,
	"authority" text NOT NULL,
	"state" "legal_hold_state" DEFAULT 'active' NOT NULL,
	"released_at" timestamp (3) with time zone,
	"released_by" text,
	"release_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "legal_holds_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "legal_holds_release_check" CHECK (("legal_holds"."state" = 'active' AND "legal_holds"."released_at" IS NULL AND "legal_holds"."released_by" IS NULL)
        OR ("legal_holds"."state" = 'released' AND "legal_holds"."released_at" IS NOT NULL AND "legal_holds"."released_by" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "resource_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"policy_id" uuid NOT NULL,
	"member_id" text,
	"role" text,
	"resource_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"state" "lifecycle_state" DEFAULT 'active' NOT NULL,
	"valid_from" timestamp (3) with time zone,
	"valid_until" timestamp (3) with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "resource_grants_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "resource_grants_grantee_check" CHECK (num_nonnulls("resource_grants"."member_id", "resource_grants"."role") = 1),
	CONSTRAINT "resource_grants_validity_check" CHECK ("resource_grants"."valid_until" IS NULL OR "resource_grants"."valid_from" IS NULL OR "resource_grants"."valid_until" >= "resource_grants"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "retention_policies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"retention_days" integer NOT NULL,
	"deletion_behavior" "deletion_behavior" NOT NULL,
	"legal_basis" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "retention_policies_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "retention_policies_workspace_resource_unique" UNIQUE("workspace_id","resource_kind"),
	CONSTRAINT "retention_policies_days_check" CHECK ("retention_policies"."retention_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"locale" text DEFAULT 'en-US' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"retention_days" integer,
	"privacy_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graph_defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ai_enabled" boolean DEFAULT false NOT NULL,
	"storage_enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "workspace_settings_workspace_unique" UNIQUE("workspace_id"),
	CONSTRAINT "workspace_settings_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_settings_version_check" CHECK ("workspace_settings"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_usage" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"people_count" integer DEFAULT 0 NOT NULL,
	"facts_count" integer DEFAULT 0 NOT NULL,
	"storage_bytes" text DEFAULT '0' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "workspace_usage_workspace_date_unique" UNIQUE("workspace_id","usage_date"),
	CONSTRAINT "workspace_usage_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_usage_counts_check" CHECK (
      "workspace_usage"."people_count" >= 0
      AND "workspace_usage"."facts_count" >= 0
      AND "workspace_usage"."storage_bytes" ~ '^[0-9]+$'
    )
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"state" "lifecycle_state" DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "workspaces_organization_unique" UNIQUE("organization_id"),
	CONSTRAINT "workspaces_id_organization_unique" UNIQUE("id","organization_id"),
	CONSTRAINT "workspaces_version_check" CHECK ("workspaces"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_reference_id_organizations_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_users_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_workspace_organization_fk" FOREIGN KEY ("workspace_id","organization_id") REFERENCES "public"."workspaces"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_definitions" ADD CONSTRAINT "fact_definitions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_relationships" ADD CONSTRAINT "fact_relationships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_relationships" ADD CONSTRAINT "fact_relationships_workspace_source_fk" FOREIGN KEY ("workspace_id","source_fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_relationships" ADD CONSTRAINT "fact_relationships_workspace_target_fk" FOREIGN KEY ("workspace_id","target_fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_revisions" ADD CONSTRAINT "fact_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fact_revisions" ADD CONSTRAINT "fact_revisions_workspace_fact_fk" FOREIGN KEY ("workspace_id","fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_definition_type_fk" FOREIGN KEY ("workspace_id","fact_definition_id","value_type") REFERENCES "public"."fact_definitions"("workspace_id","id","allowed_value_type") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_referenced_person_fk" FOREIGN KEY ("workspace_id","referenced_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_workspace_supersedes_fk" FOREIGN KEY ("workspace_id","supersedes_fact_id") REFERENCES "public"."facts"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_field_selections" ADD CONSTRAINT "person_field_selections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_field_selections" ADD CONSTRAINT "person_field_selections_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_field_selections" ADD CONSTRAINT "person_field_selections_workspace_fact_fk" FOREIGN KEY ("workspace_id","person_id","namespace","field_key","fact_id") REFERENCES "public"."facts"("workspace_id","person_id","namespace","field_key","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_records" ADD CONSTRAINT "external_records_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_candidates" ADD CONSTRAINT "identity_candidates_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_candidates" ADD CONSTRAINT "identity_candidates_workspace_first_person_fk" FOREIGN KEY ("workspace_id","first_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_candidates" ADD CONSTRAINT "identity_candidates_workspace_second_person_fk" FOREIGN KEY ("workspace_id","second_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_workspace_winner_fk" FOREIGN KEY ("workspace_id","winner_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merge_decisions" ADD CONSTRAINT "merge_decisions_workspace_loser_fk" FOREIGN KEY ("workspace_id","loser_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_merged_into_fk" FOREIGN KEY ("workspace_id","merged_into_person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_workspace_primary_name_fk" FOREIGN KEY ("workspace_id","id","primary_name_id") REFERENCES "public"."person_names"("workspace_id","person_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_events" ADD CONSTRAINT "person_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_events" ADD CONSTRAINT "person_events_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_names" ADD CONSTRAINT "person_names_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_names" ADD CONSTRAINT "person_names_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_policies" ADD CONSTRAINT "access_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_workspace_policy_fk" FOREIGN KEY ("workspace_id","policy_id") REFERENCES "public"."access_policies"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_workspace_member_fk" FOREIGN KEY ("workspace_id","member_id") REFERENCES "public"."members"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_policies" ADD CONSTRAINT "retention_policies_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_usage" ADD CONSTRAINT "workspace_usage_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_config_idx" ON "api_keys" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "api_keys_reference_idx" ON "api_keys" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "invitations_organization_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitations_email_idx" ON "invitations" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_organization_idx" ON "members" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "members_user_idx" ON "members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "two_factors_secret_idx" ON "two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "two_factors_user_idx" ON "two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "fact_definitions_workspace_category_idx" ON "fact_definitions" USING btree ("workspace_id","category");--> statement-breakpoint
CREATE INDEX "fact_relationships_workspace_source_idx" ON "fact_relationships" USING btree ("workspace_id","source_fact_id");--> statement-breakpoint
CREATE INDEX "fact_relationships_workspace_target_idx" ON "fact_relationships" USING btree ("workspace_id","target_fact_id");--> statement-breakpoint
CREATE INDEX "facts_workspace_person_idx" ON "facts" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "facts_workspace_definition_idx" ON "facts" USING btree ("workspace_id","fact_definition_id");--> statement-breakpoint
CREATE INDEX "facts_workspace_field_idx" ON "facts" USING btree ("workspace_id","namespace","field_key");--> statement-breakpoint
CREATE INDEX "facts_workspace_blind_index_idx" ON "facts" USING btree ("workspace_id","blind_index");--> statement-breakpoint
CREATE UNIQUE INDEX "person_field_selections_current_unique" ON "person_field_selections" USING btree ("workspace_id","person_id","namespace","field_key") WHERE "person_field_selections"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "consent_records_workspace_person_idx" ON "consent_records" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "people_workspace_display_name_idx" ON "people" USING btree ("workspace_id","display_name");--> statement-breakpoint
CREATE INDEX "person_events_workspace_person_idx" ON "person_events" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "person_identifiers_workspace_person_idx" ON "person_identifiers" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "person_identifiers_workspace_blind_index_idx" ON "person_identifiers" USING btree ("workspace_id","namespace","blind_index");--> statement-breakpoint
CREATE INDEX "person_names_workspace_person_idx" ON "person_names" USING btree ("workspace_id","person_id");--> statement-breakpoint
CREATE INDEX "access_policies_workspace_idx" ON "access_policies" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "deletion_requests_workspace_state_idx" ON "deletion_requests" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "legal_holds_workspace_resource_idx" ON "legal_holds" USING btree ("workspace_id","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "resource_grants_workspace_resource_idx" ON "resource_grants" USING btree ("workspace_id","resource_kind","resource_id");