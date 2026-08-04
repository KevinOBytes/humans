DROP INDEX "contact_points_workspace_blind_index_idx";--> statement-breakpoint
DROP INDEX "person_identifiers_workspace_blind_index_idx";--> statement-breakpoint
ALTER TABLE "contact_points" ADD COLUMN "blind_index_version" smallint;--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD COLUMN "blind_index_version" smallint;--> statement-breakpoint
ALTER TABLE "contact_points" ALTER COLUMN "blind_index_version" SET DEFAULT 1;--> statement-breakpoint
ALTER TABLE "person_identifiers" ALTER COLUMN "blind_index_version" SET DEFAULT 1;--> statement-breakpoint
CREATE INDEX "contact_points_workspace_blind_index_idx" ON "contact_points" USING btree ("workspace_id","kind","blind_index") WHERE "contact_points"."blind_index_version" = 1 AND "contact_points"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "person_identifiers_workspace_blind_index_idx" ON "person_identifiers" USING btree ("workspace_id","namespace","blind_index") WHERE "person_identifiers"."blind_index_version" = 1 AND "person_identifiers"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "contact_points" ADD CONSTRAINT "contact_points_blind_index_v1_check" CHECK ("contact_points"."blind_index_version" IS NULL OR ("contact_points"."blind_index_version" = 1 AND "contact_points"."blind_index" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "person_identifiers" ADD CONSTRAINT "person_identifiers_blind_index_v1_check" CHECK ("person_identifiers"."blind_index_version" IS NULL OR ("person_identifiers"."blind_index_version" = 1 AND "person_identifiers"."encrypted_raw_value" IS NOT NULL AND "person_identifiers"."blind_index" IS NOT NULL AND "person_identifiers"."normalized_value" IS NULL AND "person_identifiers"."blind_index" ~ '^[0-9a-f]{64}$'));
