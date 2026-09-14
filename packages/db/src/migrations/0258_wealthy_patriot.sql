CREATE TABLE "verrail_conversation_invocation_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invocation_id" uuid NOT NULL,
	"cursor" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_chat_invocation_events_cursor_check" CHECK ("verrail_conversation_invocation_events"."cursor" > 0),
	CONSTRAINT "verrail_chat_invocation_events_type_check" CHECK ("verrail_conversation_invocation_events"."type" in ('start', 'chunk', 'cancel_requested', 'done', 'error'))
);
--> statement-breakpoint
CREATE TABLE "verrail_conversation_invocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"principal_id" text NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"deployment_revision_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"fencing_token" integer DEFAULT 1 NOT NULL,
	"controller_id" text,
	"lease_expires_at" timestamp with time zone,
	"last_event_cursor" integer DEFAULT 0 NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"error_code" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_chat_invocations_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_chat_invocations_status_check" CHECK ("verrail_conversation_invocations"."status" in ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled')),
	CONSTRAINT "verrail_chat_invocations_counters_check" CHECK ("verrail_conversation_invocations"."fencing_token" > 0 and "verrail_conversation_invocations"."last_event_cursor" >= 0),
	CONSTRAINT "verrail_chat_invocations_terminal_check" CHECK (("verrail_conversation_invocations"."status" in ('succeeded', 'failed', 'canceled')) = ("verrail_conversation_invocations"."finished_at" is not null)),
	CONSTRAINT "verrail_chat_invocations_lease_check" CHECK (("verrail_conversation_invocations"."controller_id" is null) = ("verrail_conversation_invocations"."lease_expires_at" is null))
);
--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" ADD CONSTRAINT "verrail_messages_id_conversation_workspace_uq" UNIQUE("id","conversation_id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_deployment_revisions" ADD CONSTRAINT "verrail_deploy_revisions_id_version_workspace_uq" UNIQUE("id","agent_version_id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_conversation_invocation_events" ADD CONSTRAINT "verrail_chat_invocation_events_scope_fk" FOREIGN KEY ("invocation_id","workspace_id") REFERENCES "public"."verrail_conversation_invocations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_invocations" ADD CONSTRAINT "verrail_conversation_invocations_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_invocations" ADD CONSTRAINT "verrail_chat_invocations_source_fk" FOREIGN KEY ("source_message_id","conversation_id","workspace_id") REFERENCES "public"."verrail_conversation_messages"("id","conversation_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_invocations" ADD CONSTRAINT "verrail_chat_invocations_version_fk" FOREIGN KEY ("deployment_revision_id","agent_version_id","workspace_id") REFERENCES "public"."verrail_deployment_revisions"("id","agent_version_id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_chat_invocation_events_cursor_uq" ON "verrail_conversation_invocation_events" USING btree ("invocation_id","cursor");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_chat_invocations_source_uq" ON "verrail_conversation_invocations" USING btree ("source_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_chat_invocations_request_uq" ON "verrail_conversation_invocations" USING btree ("workspace_id","principal_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_chat_invocations_active_uq" ON "verrail_conversation_invocations" USING btree ("workspace_id","conversation_id") WHERE "verrail_conversation_invocations"."status" in ('queued', 'running', 'cancel_requested');--> statement-breakpoint
CREATE INDEX "verrail_chat_invocations_conversation_idx" ON "verrail_conversation_invocations" USING btree ("workspace_id","conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_chat_invocations_recovery_idx" ON "verrail_conversation_invocations" USING btree ("status","lease_expires_at");
