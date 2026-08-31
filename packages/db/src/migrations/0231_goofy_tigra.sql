CREATE TABLE "verrail_conversation_context_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"context_type" text NOT NULL,
	"context_id" text NOT NULL,
	"label" text,
	"href" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_conversation_context_bindings_type_check" CHECK ("verrail_conversation_context_bindings"."context_type" in ('project', 'target', 'target_revision', 'stage', 'artifact_revision', 'review', 'run', 'action_request'))
);
--> statement-breakpoint
CREATE TABLE "verrail_conversation_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'complete' NOT NULL,
	"body" text NOT NULL,
	"author_principal_type" text,
	"author_principal_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_conversation_messages_role_check" CHECK ("verrail_conversation_messages"."role" in ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "verrail_conversation_messages_status_check" CHECK ("verrail_conversation_messages"."status" in ('complete', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "verrail_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned_at" timestamp with time zone,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_conversations_status_check" CHECK ("verrail_conversations"."status" in ('active', 'archived'))
);
--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_bindings" ADD CONSTRAINT "verrail_conversation_context_bindings_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_bindings" ADD CONSTRAINT "verrail_conversation_context_bindings_conversation_id_verrail_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."verrail_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" ADD CONSTRAINT "verrail_conversation_messages_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" ADD CONSTRAINT "verrail_conversation_messages_conversation_id_verrail_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."verrail_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversations" ADD CONSTRAINT "verrail_conversations_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_conversation_context_bindings_context_uq" ON "verrail_conversation_context_bindings" USING btree ("conversation_id","context_type","context_id");--> statement-breakpoint
CREATE INDEX "verrail_conversation_context_bindings_workspace_context_idx" ON "verrail_conversation_context_bindings" USING btree ("workspace_id","context_type","context_id");--> statement-breakpoint
CREATE INDEX "verrail_conversation_messages_conversation_created_idx" ON "verrail_conversation_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_conversation_messages_workspace_created_idx" ON "verrail_conversation_messages" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_conversations_workspace_status_activity_idx" ON "verrail_conversations" USING btree ("workspace_id","status","last_message_at");--> statement-breakpoint
CREATE INDEX "verrail_conversations_workspace_pinned_idx" ON "verrail_conversations" USING btree ("workspace_id","pinned_at");