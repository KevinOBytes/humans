CREATE TABLE "location_mutation_idempotency" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_principal_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key_hash" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_reference" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "location_mutation_idempotency_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "location_mutation_idempotency_claim_unique" UNIQUE("workspace_id","actor_principal_id","operation","key_hash"),
	CONSTRAINT "location_mutation_idempotency_hashes_check" CHECK ("location_mutation_idempotency"."key_hash" ~ '^[0-9a-f]{64}$' AND "location_mutation_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "location_mutation_idempotency_status_check" CHECK ("location_mutation_idempotency"."status" IN ('pending', 'completed')),
	CONSTRAINT "location_mutation_idempotency_response_check" CHECK ("location_mutation_idempotency"."response_reference" IS NULL OR jsonb_typeof("location_mutation_idempotency"."response_reference") = 'object')
);
--> statement-breakpoint
ALTER TABLE "addresses" DROP CONSTRAINT "addresses_normalized_hash_check";--> statement-breakpoint
-- Existing address hashes predate the canonical workspace-HMAC contract. Keep
-- them usable but explicitly unversioned; only rows written after this forward
-- migration receive version 1.
ALTER TABLE "addresses" ADD COLUMN "normalized_hash_version" smallint;--> statement-breakpoint
UPDATE "addresses" SET "normalized_hash_version" = NULL;--> statement-breakpoint
ALTER TABLE "addresses" ALTER COLUMN "normalized_hash_version" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "location_mutation_idempotency" ADD CONSTRAINT "location_mutation_idempotency_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_mutation_idempotency" ADD CONSTRAINT "location_mutation_idempotency_workspace_principal_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_mutation_idempotency_expiry_idx" ON "location_mutation_idempotency" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "places_workspace_canonical_name_idx" ON "places" USING btree ("workspace_id",lower("name" COLLATE "C"),"id");--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_normalized_hash_check" CHECK ("addresses"."normalized_hash_version" IS NULL OR ("addresses"."normalized_hash_version" = 1 AND "addresses"."normalized_hash" ~ '^[0-9a-f]{64}$'));
