CREATE TABLE "verrail_channel_target_replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"draft_revision_id" uuid NOT NULL,
	"channel_event_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"plugin_id" uuid NOT NULL,
	"confirmed_by_principal_id" text NOT NULL,
	"configuration_sha256" text NOT NULL,
	"context_sha256" text NOT NULL,
	"body_sha256" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "verrail_channel_target_replies_status_check" CHECK ("verrail_channel_target_replies"."status" in ('sending', 'succeeded', 'unknown')),
	CONSTRAINT "verrail_channel_target_replies_receipt_check" CHECK (("verrail_channel_target_replies"."status" = 'succeeded' and "verrail_channel_target_replies"."provider_message_id" is not null and "verrail_channel_target_replies"."completed_at" is not null) or ("verrail_channel_target_replies"."status" <> 'succeeded' and "verrail_channel_target_replies"."provider_message_id" is null))
);
--> statement-breakpoint
ALTER TABLE "verrail_channel_target_replies" ADD CONSTRAINT "verrail_channel_target_replies_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_channel_target_replies_draft_uq" ON "verrail_channel_target_replies" USING btree ("workspace_id","draft_id");--> statement-breakpoint
CREATE INDEX "verrail_channel_target_replies_target_idx" ON "verrail_channel_target_replies" USING btree ("workspace_id","target_id");