CREATE TABLE "person_file_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"label" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	"deleted_at" timestamp (3) with time zone,
	"deleted_by" text,
	CONSTRAINT "person_file_attachments_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "person_file_attachments_label_length_check" CHECK ("person_file_attachments"."label" IS NULL OR octet_length("person_file_attachments"."label") <= 500),
	CONSTRAINT "person_file_attachments_version_check" CHECK ("person_file_attachments"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "person_file_attachments" ADD CONSTRAINT "person_file_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_file_attachments" ADD CONSTRAINT "person_file_attachments_workspace_person_fk" FOREIGN KEY ("workspace_id","person_id") REFERENCES "public"."people"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_file_attachments" ADD CONSTRAINT "person_file_attachments_workspace_file_fk" FOREIGN KEY ("workspace_id","file_id") REFERENCES "public"."files"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "person_file_attachments_current_pair_unique" ON "person_file_attachments" USING btree ("workspace_id","person_id","file_id") WHERE "person_file_attachments"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "person_file_attachments_workspace_person_idx" ON "person_file_attachments" USING btree ("workspace_id","person_id","created_at");--> statement-breakpoint
CREATE INDEX "person_file_attachments_workspace_file_idx" ON "person_file_attachments" USING btree ("workspace_id","file_id");