CREATE TABLE "verrail_graph_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"work_graph_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_graph_revisions_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_graph_revisions_status_check" CHECK ("verrail_graph_revisions"."status" in ('draft', 'active', 'superseded', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "verrail_provider_conversation_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"provider_key" text NOT NULL,
	"connection_id" text NOT NULL,
	"external_conversation_type" text NOT NULL,
	"external_conversation_id" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_provider_conversation_bindings_type_check" CHECK ("verrail_provider_conversation_bindings"."external_conversation_type" in ('group', 'direct'))
);
--> statement-breakpoint
CREATE TABLE "verrail_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"work_node_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"actor_principal_type" text NOT NULL,
	"actor_principal_id" text NOT NULL,
	"actor_display_name" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_runs_kind_check" CHECK ("verrail_runs"."kind" in ('agent', 'integration')),
	CONSTRAINT "verrail_runs_status_check" CHECK ("verrail_runs"."status" in ('queued', 'running', 'cancel_requested', 'succeeded', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "verrail_target_creation_draft_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"definition" jsonb NOT NULL,
	"missing_fields" jsonb NOT NULL,
	"field_sources" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_target_creation_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"source_message_id" uuid NOT NULL,
	"initiated_by_principal_type" text NOT NULL,
	"initiated_by_principal_id" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"active_revision_id" uuid NOT NULL,
	"active_revision_number" integer DEFAULT 1 NOT NULL,
	"converted_target_id" uuid,
	"converted_target_revision_id" uuid,
	"confirmed_by_principal_type" text,
	"confirmed_by_principal_id" text,
	"confirmed_at" timestamp with time zone,
	"conversion_idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_target_creation_drafts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_target_creation_drafts_status_check" CHECK ("verrail_target_creation_drafts"."status" in ('collecting', 'ready_for_confirmation', 'converting', 'converted', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "verrail_work_graphs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"active_graph_revision_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_work_graphs_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_work_graphs_status_check" CHECK ("verrail_work_graphs"."status" in ('draft', 'active', 'completed', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "verrail_work_nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"node_key" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"stage_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"responsible_principal_type" text,
	"responsible_principal_id" text,
	"dependency_node_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"completion_definition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_work_nodes_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_work_nodes_kind_check" CHECK ("verrail_work_nodes"."kind" in ('agent_task', 'human_task', 'integration_task', 'decision_gate', 'review_gate', 'acceptance_gate', 'policy_gate')),
	CONSTRAINT "verrail_work_nodes_stage_check" CHECK ("verrail_work_nodes"."stage_key" in ('define', 'execute', 'verify', 'accept')),
	CONSTRAINT "verrail_work_nodes_status_check" CHECK ("verrail_work_nodes"."status" in ('pending', 'ready', 'running', 'completed', 'blocked', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" DROP CONSTRAINT "verrail_target_revisions_target_id_verrail_targets_id_fk";
--> statement-breakpoint
ALTER TABLE "verrail_targets" DROP CONSTRAINT "verrail_targets_collection_id_verrail_collections_id_fk";
--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" ADD COLUMN "resource_refs" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "verrail_collections" ADD CONSTRAINT "verrail_collections_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_conversation_messages" ADD CONSTRAINT "verrail_conversation_messages_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" ADD CONSTRAINT "verrail_target_revisions_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_graph_revisions" ADD CONSTRAINT "verrail_graph_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_graph_revisions" ADD CONSTRAINT "verrail_graph_revisions_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_graph_revisions" ADD CONSTRAINT "verrail_graph_revisions_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_graph_revisions" ADD CONSTRAINT "verrail_graph_revisions_graph_workspace_fk" FOREIGN KEY ("work_graph_id","workspace_id") REFERENCES "public"."verrail_work_graphs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_provider_conversation_bindings" ADD CONSTRAINT "verrail_provider_conversation_bindings_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_provider_conversation_bindings" ADD CONSTRAINT "verrail_provider_conversation_bindings_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."verrail_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD CONSTRAINT "verrail_runs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD CONSTRAINT "verrail_runs_node_workspace_fk" FOREIGN KEY ("work_node_id","workspace_id") REFERENCES "public"."verrail_work_nodes"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_draft_revisions" ADD CONSTRAINT "verrail_target_creation_draft_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_draft_revisions" ADD CONSTRAINT "verrail_target_creation_draft_revisions_draft_workspace_fk" FOREIGN KEY ("draft_id","workspace_id") REFERENCES "public"."verrail_target_creation_drafts"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_drafts" ADD CONSTRAINT "verrail_target_creation_drafts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_drafts" ADD CONSTRAINT "verrail_target_creation_drafts_conversation_workspace_fk" FOREIGN KEY ("conversation_id","workspace_id") REFERENCES "public"."verrail_conversations"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_creation_drafts" ADD CONSTRAINT "verrail_target_creation_drafts_source_message_workspace_fk" FOREIGN KEY ("source_message_id","workspace_id") REFERENCES "public"."verrail_conversation_messages"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_work_graphs" ADD CONSTRAINT "verrail_work_graphs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_work_graphs" ADD CONSTRAINT "verrail_work_graphs_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_work_nodes" ADD CONSTRAINT "verrail_work_nodes_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_work_nodes" ADD CONSTRAINT "verrail_work_nodes_graph_workspace_fk" FOREIGN KEY ("graph_revision_id","workspace_id") REFERENCES "public"."verrail_graph_revisions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_graph_revisions_graph_number_uq" ON "verrail_graph_revisions" USING btree ("work_graph_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_provider_conversation_bindings_external_uq" ON "verrail_provider_conversation_bindings" USING btree ("workspace_id","connection_id","external_conversation_id");--> statement-breakpoint
CREATE INDEX "verrail_provider_conversation_bindings_conversation_idx" ON "verrail_provider_conversation_bindings" USING btree ("workspace_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_runs_workspace_idempotency_uq" ON "verrail_runs" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "verrail_runs_target_created_idx" ON "verrail_runs" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_target_creation_draft_revisions_number_uq" ON "verrail_target_creation_draft_revisions" USING btree ("draft_id","revision_number");--> statement-breakpoint
CREATE INDEX "verrail_target_creation_drafts_conversation_status_idx" ON "verrail_target_creation_drafts" USING btree ("workspace_id","conversation_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_work_graphs_target_uq" ON "verrail_work_graphs" USING btree ("target_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_work_nodes_graph_key_uq" ON "verrail_work_nodes" USING btree ("graph_revision_id","node_key");--> statement-breakpoint
CREATE INDEX "verrail_work_nodes_graph_status_idx" ON "verrail_work_nodes" USING btree ("graph_revision_id","status");--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" ADD CONSTRAINT "verrail_target_revisions_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_collection_workspace_fk" FOREIGN KEY ("collection_id","workspace_id") REFERENCES "public"."verrail_collections"("id","workspace_id") ON DELETE restrict ON UPDATE no action;
