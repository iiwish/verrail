CREATE TABLE "verrail_conversation_context_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"principal_id" text NOT NULL,
	"source_message_id" uuid,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verrail_conversations" ADD COLUMN "current_target_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_conversations" ADD COLUMN "context_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_drafts" ADD COLUMN "confirmation_context_version" integer;--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_changes" ADD CONSTRAINT "verrail_conversation_context_changes_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."verrail_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_conversation_context_changes_command_uq" ON "verrail_conversation_context_changes" USING btree ("conversation_id","principal_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "verrail_conversations" ADD CONSTRAINT "verrail_conversations_current_target_workspace_fk" FOREIGN KEY ("current_target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversations" ADD CONSTRAINT "verrail_conversations_context_version_check" CHECK ("verrail_conversations"."context_version" >= 0);