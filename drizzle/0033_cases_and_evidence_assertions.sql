CREATE TABLE "case_members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"principal_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "case_members_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "case_members_principal_unique" UNIQUE("workspace_id","case_id","principal_id"),
	CONSTRAINT "case_members_role_check" CHECK ("case_members"."role" IN ('owner', 'member', 'reviewer')),
	CONSTRAINT "case_members_version_check" CHECK ("case_members"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "case_resource_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"case_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"observed_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "case_resource_links_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "case_resource_links_resource_unique" UNIQUE("workspace_id","case_id","resource_kind","resource_id"),
	CONSTRAINT "case_resource_links_kind_check" CHECK ("case_resource_links"."resource_kind" IN ('person', 'fact', 'relationship')),
	CONSTRAINT "case_resource_links_version_check" CHECK ("case_resource_links"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "cases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"purpose" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "cases_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "cases_version_check" CHECK ("cases"."version" > 0),
	CONSTRAINT "cases_state_check" CHECK ("cases"."state" IN ('active', 'closed')),
	CONSTRAINT "cases_text_check" CHECK (length("cases"."title") BETWEEN 1 AND 200 AND length("cases"."purpose") BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE TABLE "evidence_assertion_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"assertion_id" uuid NOT NULL,
	"assertion_version" integer NOT NULL,
	"resource_version" integer NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	CONSTRAINT "evidence_assertion_reviews_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "evidence_assertion_reviews_version_unique" UNIQUE("workspace_id","assertion_id","assertion_version"),
	CONSTRAINT "evidence_assertion_reviews_state_check" CHECK ("evidence_assertion_reviews"."state" IN ('approved', 'rejected')),
	CONSTRAINT "evidence_assertion_reviews_version_check" CHECK ("evidence_assertion_reviews"."assertion_version" > 0 AND "evidence_assertion_reviews"."resource_version" > 0),
	CONSTRAINT "evidence_assertion_reviews_reason_check" CHECK (length("evidence_assertion_reviews"."reason") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "evidence_assertions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"evidence_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"resource_id" uuid NOT NULL,
	"case_id" uuid,
	"purpose" text NOT NULL,
	"locator" text NOT NULL,
	"quote" text NOT NULL,
	"role" text NOT NULL,
	"confidence" numeric(4, 3) NOT NULL,
	"review_state" text DEFAULT 'unreviewed' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "evidence_assertions_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "evidence_assertions_kind_check" CHECK ("evidence_assertions"."resource_kind" IN ('person', 'fact', 'relationship')),
	CONSTRAINT "evidence_assertions_role_check" CHECK ("evidence_assertions"."role" IN ('supports', 'contradicts', 'context')),
	CONSTRAINT "evidence_assertions_review_check" CHECK ("evidence_assertions"."review_state" IN ('unreviewed', 'approved', 'rejected')),
	CONSTRAINT "evidence_assertions_confidence_check" CHECK ("evidence_assertions"."confidence" BETWEEN 0 AND 1),
	CONSTRAINT "evidence_assertions_text_check" CHECK (length("evidence_assertions"."locator") BETWEEN 1 AND 2048 AND length("evidence_assertions"."quote") BETWEEN 1 AND 8000 AND length("evidence_assertions"."purpose") BETWEEN 1 AND 200),
	CONSTRAINT "evidence_assertions_version_check" CHECK ("evidence_assertions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "case_id" uuid;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "observed_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "creation_method" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "relationships" ADD COLUMN "review_state" text DEFAULT 'unreviewed' NOT NULL;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_members" ADD CONSTRAINT "case_members_workspace_principal_fk" FOREIGN KEY ("workspace_id","principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resource_links" ADD CONSTRAINT "case_resource_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "case_resource_links" ADD CONSTRAINT "case_resource_links_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cases" ADD CONSTRAINT "cases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assertion_reviews" ADD CONSTRAINT "evidence_assertion_reviews_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assertion_reviews" ADD CONSTRAINT "evidence_assertion_reviews_workspace_assertion_fk" FOREIGN KEY ("workspace_id","assertion_id") REFERENCES "public"."evidence_assertions"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assertions" ADD CONSTRAINT "evidence_assertions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assertions" ADD CONSTRAINT "evidence_assertions_workspace_evidence_fk" FOREIGN KEY ("workspace_id","evidence_id") REFERENCES "public"."evidence_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assertions" ADD CONSTRAINT "evidence_assertions_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "case_resource_links_lookup_idx" ON "case_resource_links" USING btree ("workspace_id","resource_kind","resource_id");--> statement-breakpoint
CREATE INDEX "case_resource_links_timeline_idx" ON "case_resource_links" USING btree ("workspace_id","case_id","observed_at","id");--> statement-breakpoint
CREATE INDEX "cases_workspace_created_idx" ON "cases" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "evidence_assertions_resource_idx" ON "evidence_assertions" USING btree ("workspace_id","resource_kind","resource_id");--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_workspace_case_fk" FOREIGN KEY ("workspace_id","case_id") REFERENCES "public"."cases"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relationships_workspace_case_observed_idx" ON "relationships" USING btree ("workspace_id","case_id","observed_at");--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_creation_method_check" CHECK ("relationships"."creation_method" IN ('manual', 'import', 'ai'));--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_review_state_check" CHECK ("relationships"."review_state" IN ('unreviewed', 'approved', 'rejected'));--> statement-breakpoint
-- Polymorphic references use an allowlisted trigger, never a caller-selected table.
CREATE FUNCTION enforce_case_assertion_resource() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_resource uuid;
BEGIN
  CASE NEW.resource_kind
    WHEN 'person' THEN SELECT id INTO found_resource FROM people WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND deleted_at IS NULL FOR SHARE;
    WHEN 'fact' THEN SELECT id INTO found_resource FROM facts WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND deleted_at IS NULL FOR SHARE;
    WHEN 'relationship' THEN SELECT id INTO found_resource FROM relationships WHERE workspace_id = NEW.workspace_id AND id = NEW.resource_id AND deleted_at IS NULL FOR SHARE;
    ELSE RAISE EXCEPTION 'Invalid resource kind' USING ERRCODE = '23514';
  END CASE;
  IF found_resource IS NULL THEN RAISE EXCEPTION 'Resource is not in the workspace' USING ERRCODE = '23503'; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER case_resource_links_workspace_resource_guard BEFORE INSERT OR UPDATE OF workspace_id, resource_kind, resource_id ON case_resource_links FOR EACH ROW EXECUTE FUNCTION enforce_case_assertion_resource();--> statement-breakpoint
CREATE TRIGGER evidence_assertions_workspace_resource_guard BEFORE INSERT OR UPDATE OF workspace_id, resource_kind, resource_id ON evidence_assertions FOR EACH ROW EXECUTE FUNCTION enforce_case_assertion_resource();
