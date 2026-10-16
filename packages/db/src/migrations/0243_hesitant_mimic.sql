ALTER TABLE "verrail_action_requests" DROP CONSTRAINT "verrail_action_requests_status_check";--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD COLUMN "provider_marker" text;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD COLUMN "execution_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD COLUMN "execution_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD COLUMN "last_reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD COLUMN "provider_marker" text;--> statement-breakpoint
UPDATE "verrail_effect_receipts"
SET "provider_marker" = md5("id"::text) || md5('legacy:' || "id"::text);--> statement-breakpoint
UPDATE "verrail_action_requests" AS request
SET "provider_marker" = receipt."provider_marker"
FROM "verrail_effect_receipts" AS receipt
WHERE receipt."action_request_id" = request."id";--> statement-breakpoint
UPDATE "verrail_action_requests"
SET "provider_marker" = md5("id"::text) || md5('legacy:' || "id"::text)
WHERE "status" = 'executed' AND "provider_marker" IS NULL;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ALTER COLUMN "provider_marker" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_action_requests_provider_marker_uq" ON "verrail_action_requests" USING btree ("provider_marker") WHERE "verrail_action_requests"."provider_marker" is not null;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_action_request_uq" UNIQUE("action_request_id");--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_provider_marker_uq" UNIQUE("provider_marker");--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_provider_marker_check" CHECK (("verrail_action_requests"."status" in ('pending_approval', 'approved') and "verrail_action_requests"."provider_marker" is null)
        or ("verrail_action_requests"."status" in ('executing', 'unknown_effect', 'executed') and "verrail_action_requests"."provider_marker" ~ '^[0-9a-f]{64}$'));--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_execution_attempt_count_check" CHECK ("verrail_action_requests"."execution_attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_status_check" CHECK ("verrail_action_requests"."status" in ('pending_approval', 'approved', 'executing', 'unknown_effect', 'executed'));--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_provider_marker_check" CHECK ("verrail_effect_receipts"."provider_marker" ~ '^[0-9a-f]{64}$');
