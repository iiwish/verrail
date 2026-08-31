DROP INDEX "verrail_outbox_events_aggregate_idx";--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "workflow_id" text;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD COLUMN "last_error" text;--> statement-breakpoint
CREATE INDEX "verrail_outbox_events_aggregate_idx" ON "verrail_outbox_events" USING btree ("aggregate_type","aggregate_id","created_at");--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_status_check" CHECK ("verrail_outbox_events"."status" IN ('pending', 'delivering', 'delivered', 'failed'));--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_attempt_count_check" CHECK ("verrail_outbox_events"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_delivery_claim_check" CHECK ("verrail_outbox_events"."status" <> 'delivering' OR ("verrail_outbox_events"."claim_token" IS NOT NULL AND "verrail_outbox_events"."claimed_at" IS NOT NULL AND "verrail_outbox_events"."lease_expires_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_delivered_check" CHECK ("verrail_outbox_events"."status" <> 'delivered' OR ("verrail_outbox_events"."workflow_id" IS NOT NULL AND "verrail_outbox_events"."published_at" IS NOT NULL));