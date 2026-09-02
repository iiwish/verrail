CREATE TABLE "verrail_collections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_bindings" DROP CONSTRAINT "verrail_conversation_context_bindings_type_check";--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD COLUMN "collection_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_collections" ADD CONSTRAINT "verrail_collections_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_collections_workspace_name_uq" ON "verrail_collections" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "verrail_collections_workspace_updated_idx" ON "verrail_collections" USING btree ("workspace_id","updated_at");--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_collection_id_verrail_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."verrail_collections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_targets_workspace_collection_updated_idx" ON "verrail_targets" USING btree ("workspace_id","collection_id","updated_at");--> statement-breakpoint
ALTER TABLE "verrail_conversation_context_bindings" ADD CONSTRAINT "verrail_conversation_context_bindings_type_check" CHECK ("verrail_conversation_context_bindings"."context_type" in ('collection', 'target', 'target_revision', 'stage', 'artifact_revision', 'review', 'run', 'action_request'));