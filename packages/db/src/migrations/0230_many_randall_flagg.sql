DROP INDEX IF EXISTS "verrail_outbox_events_aggregate_idx";--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "workflow_id" text;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verrail_outbox_events_aggregate_idx" ON "verrail_outbox_events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'verrail_outbox_events_status_check'
			AND conrelid = 'verrail_outbox_events'::regclass
	) THEN
		ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_status_check" CHECK ("verrail_outbox_events"."status" IN ('pending', 'delivering', 'delivered', 'failed'));
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'verrail_outbox_events_attempt_count_check'
			AND conrelid = 'verrail_outbox_events'::regclass
	) THEN
		ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_attempt_count_check" CHECK ("verrail_outbox_events"."attempt_count" >= 0);
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'verrail_outbox_events_delivery_claim_check'
			AND conrelid = 'verrail_outbox_events'::regclass
	) THEN
		ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_delivery_claim_check" CHECK ("verrail_outbox_events"."status" <> 'delivering' OR ("verrail_outbox_events"."claim_token" IS NOT NULL AND "verrail_outbox_events"."claimed_at" IS NOT NULL AND "verrail_outbox_events"."lease_expires_at" IS NOT NULL));
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'verrail_outbox_events_delivered_check'
			AND conrelid = 'verrail_outbox_events'::regclass
	) THEN
		ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_delivered_check" CHECK ("verrail_outbox_events"."status" <> 'delivered' OR ("verrail_outbox_events"."workflow_id" IS NOT NULL AND "verrail_outbox_events"."published_at" IS NOT NULL));
	END IF;
END $$;
