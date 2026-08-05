DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "webhook_deliveries" LIMIT 1) THEN
    RAISE EXCEPTION '0024_webhook_delivery_payload requires webhook_deliveries to be empty; replay or archive existing delivery rows before upgrading';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "encrypted_payload" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD COLUMN "payload_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_payload_hash_check" CHECK ("webhook_deliveries"."payload_hash" ~ '^sha256:[0-9a-f]{64}$');
