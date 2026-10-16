CREATE TABLE "verrail_channel_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connector_key" text NOT NULL,
	"connection_id" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"external_conversation_type" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"draft_id" uuid,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_channel_events_conversation_type_check" CHECK ("verrail_channel_events"."external_conversation_type" in ('group', 'direct'))
);
--> statement-breakpoint
ALTER TABLE "verrail_channel_events" ADD CONSTRAINT "verrail_channel_events_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_channel_events_workspace_event_uq" ON "verrail_channel_events" USING btree ("workspace_id","connector_key","connection_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "verrail_channel_events_workspace_conversation_idx" ON "verrail_channel_events" USING btree ("workspace_id","connection_id","external_conversation_id","received_at");