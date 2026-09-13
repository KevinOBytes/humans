ALTER TABLE "relationships" ADD COLUMN "epistemic_status" text DEFAULT 'documented' NOT NULL;--> statement-breakpoint
UPDATE "relationships"
SET "epistemic_status" = 'analyst_hypothesis'
WHERE "creation_method" = 'ai';--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_epistemic_status_check" CHECK ("relationships"."epistemic_status" IN ('documented', 'analyst_hypothesis'));
