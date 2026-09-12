CREATE TABLE "source_custody_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"collector" text,
	"integrity_hash" text,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "source_custody_events_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "source_custody_events_kind_check" CHECK ("source_custody_events"."event_kind" IN ('collected', 'verified', 'transferred', 'accessed', 'redacted')),
	CONSTRAINT "source_custody_events_text_check" CHECK ("source_custody_events"."event_kind" <> '' AND ("source_custody_events"."collector" IS NULL OR length("source_custody_events"."collector") BETWEEN 1 AND 300) AND ("source_custody_events"."notes" IS NULL OR length("source_custody_events"."notes") BETWEEN 1 AND 4000))
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "publication_date" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "collector" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "extraction_method" text;--> statement-breakpoint
ALTER TABLE "source_custody_events" ADD CONSTRAINT "source_custody_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_custody_events" ADD CONSTRAINT "source_custody_events_workspace_source_fk" FOREIGN KEY ("workspace_id","source_id") REFERENCES "public"."sources"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_custody_events_workspace_source_idx" ON "source_custody_events" USING btree ("workspace_id","source_id","occurred_at");
--> statement-breakpoint
CREATE FUNCTION "reject_source_custody_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'source custody events are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "source_custody_events_immutable_update"
  BEFORE UPDATE OR DELETE ON "source_custody_events"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_custody_mutation"();
