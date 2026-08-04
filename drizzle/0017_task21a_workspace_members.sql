ALTER TABLE "auth_email_outbox" DROP CONSTRAINT "auth_email_outbox_kind_check";--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD COLUMN "invitation_id" text;--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
WITH "ranked_pending_invitations" AS (
	SELECT "id", row_number() OVER (
		PARTITION BY "organization_id", lower("email")
		ORDER BY "expires_at" DESC, "created_at" DESC, "id" DESC
	) AS "rank"
	FROM "invitations"
	WHERE "status" = 'pending'
)
UPDATE "invitations"
SET "status" = 'canceled'
FROM "ranked_pending_invitations"
WHERE "invitations"."id" = "ranked_pending_invitations"."id"
	AND "ranked_pending_invitations"."rank" > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_live_recipient_unique" ON "invitations" USING btree ("organization_id",lower("email")) WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "auth_email_outbox_invitation_idx" ON "auth_email_outbox" USING btree ("invitation_id","state");--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_invitation_binding_check" CHECK (("auth_email_outbox"."kind" = 'workspace_invitation' AND "auth_email_outbox"."invitation_id" IS NOT NULL) OR ("auth_email_outbox"."kind" = 'verification' AND "auth_email_outbox"."invitation_id" IS NULL));--> statement-breakpoint
ALTER TABLE "auth_email_outbox" ADD CONSTRAINT "auth_email_outbox_kind_check" CHECK ("auth_email_outbox"."kind" IN ('verification', 'workspace_invitation'));
