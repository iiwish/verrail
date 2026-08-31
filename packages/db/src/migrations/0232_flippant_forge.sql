ALTER TABLE "verrail_conversation_context_bindings" DROP CONSTRAINT "verrail_conversation_context_bindings_conversation_id_verrail_conversations_id_fk";
--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" DROP CONSTRAINT "verrail_conversation_messages_conversation_id_verrail_conversations_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_conversations_id_workspace_uq" ON "verrail_conversations" USING btree ("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_bindings" ADD CONSTRAINT "verrail_conversation_context_bindings_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."verrail_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" ADD CONSTRAINT "verrail_conversation_messages_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."verrail_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;
