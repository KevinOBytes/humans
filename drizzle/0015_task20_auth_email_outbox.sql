CREATE TABLE "auth_email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"payload_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"claim_generation" integer DEFAULT 0 NOT NULL,
	"scheduled_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp (3) with time zone,
	"provider_message_id" text,
	"error_code" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp (3) with time zone,
	CONSTRAINT "auth_email_outbox_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "auth_email_outbox_kind_check" CHECK ("auth_email_outbox"."kind" IN ('verification')),
	CONSTRAINT "auth_email_outbox_state_check" CHECK ("auth_email_outbox"."state" IN ('queued', 'running', 'completed', 'dead_letter')),
	CONSTRAINT "auth_email_outbox_payload_hash_check" CHECK ("auth_email_outbox"."payload_hash" ~ '^sha256:[0-9a-f]{64}$'),
	CONSTRAINT "auth_email_outbox_attempt_count_check" CHECK ("auth_email_outbox"."attempt_count" >= 0),
	CONSTRAINT "auth_email_outbox_claim_generation_check" CHECK ("auth_email_outbox"."claim_generation" >= 0),
	CONSTRAINT "auth_email_outbox_lease_check" CHECK (("auth_email_outbox"."lease_owner" IS NULL AND "auth_email_outbox"."lease_expires_at" IS NULL) OR ("auth_email_outbox"."lease_owner" IS NOT NULL AND "auth_email_outbox"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "auth_email_outbox_claim_idx" ON "auth_email_outbox" USING btree ("state","scheduled_at","id");