CREATE TABLE "research_assignment_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assignment_id" uuid NOT NULL,
	"event_kind" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"from_assignee_principal_id" uuid,
	"to_assignee_principal_id" uuid,
	"reason" text,
	"actor_principal_id" uuid NOT NULL,
	"occurred_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_assignment_events_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "research_assignment_events_kind_check" CHECK ("research_assignment_events"."event_kind" IN ('created', 'assigned', 'status_changed', 'escalated')),
	CONSTRAINT "research_assignment_events_reason_check" CHECK ("research_assignment_events"."reason" IS NULL OR length(trim("research_assignment_events"."reason")) BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "research_assignment_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid,
	"queue_kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignee_principal_id" uuid,
	"due_at" timestamp (3) with time zone,
	"escalation_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid NOT NULL,
	CONSTRAINT "research_assignment_items_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "research_assignment_items_kind_check" CHECK ("research_assignment_items"."queue_kind" IN ('review', 'verification', 'consent_follow_up', 'source_reconciliation', 'privacy_request')),
	CONSTRAINT "research_assignment_items_status_check" CHECK ("research_assignment_items"."status" IN ('open', 'in_progress', 'blocked', 'completed', 'cancelled')),
	CONSTRAINT "research_assignment_items_priority_check" CHECK ("research_assignment_items"."priority" BETWEEN 0 AND 100),
	CONSTRAINT "research_assignment_items_escalation_check" CHECK ("research_assignment_items"."escalation_count" BETWEEN 0 AND 1000),
	CONSTRAINT "research_assignment_items_version_check" CHECK ("research_assignment_items"."version" > 0),
	CONSTRAINT "research_assignment_items_text_check" CHECK (length(trim("research_assignment_items"."title")) BETWEEN 1 AND 200 AND ("research_assignment_items"."description" IS NULL OR length("research_assignment_items"."description") <= 4000))
);
--> statement-breakpoint
ALTER TABLE "research_assignment_events" ADD CONSTRAINT "research_assignment_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_events" ADD CONSTRAINT "research_assignment_events_item_fk" FOREIGN KEY ("workspace_id","assignment_id") REFERENCES "public"."research_assignment_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_events" ADD CONSTRAINT "research_assignment_events_actor_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_events" ADD CONSTRAINT "research_assignment_events_from_assignee_fk" FOREIGN KEY ("workspace_id","from_assignee_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_events" ADD CONSTRAINT "research_assignment_events_to_assignee_fk" FOREIGN KEY ("workspace_id","to_assignee_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_items" ADD CONSTRAINT "research_assignment_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_items" ADD CONSTRAINT "research_assignment_items_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_items" ADD CONSTRAINT "research_assignment_items_assignee_fk" FOREIGN KEY ("workspace_id","assignee_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_items" ADD CONSTRAINT "research_assignment_items_created_by_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_assignment_items" ADD CONSTRAINT "research_assignment_items_updated_by_fk" FOREIGN KEY ("workspace_id","updated_by") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "research_assignment_events_item_idx" ON "research_assignment_events" USING btree ("workspace_id","assignment_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "research_assignment_items_queue_idx" ON "research_assignment_items" USING btree ("workspace_id","status","priority","due_at","id");--> statement-breakpoint
CREATE INDEX "research_assignment_items_case_idx" ON "research_assignment_items" USING btree ("workspace_id","case_id","status","id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION humans_research_assignment_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Research assignment events are append-only' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER research_assignment_events_no_update BEFORE UPDATE ON research_assignment_events FOR EACH ROW EXECUTE FUNCTION humans_research_assignment_events_append_only();
--> statement-breakpoint
CREATE TRIGGER research_assignment_events_no_delete BEFORE DELETE ON research_assignment_events FOR EACH ROW EXECUTE FUNCTION humans_research_assignment_events_append_only();
