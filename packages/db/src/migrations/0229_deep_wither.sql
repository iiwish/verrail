CREATE TABLE "verrail_audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_command_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"command_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_target_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"outcome_owner_principal_type" text NOT NULL,
	"outcome_owner_principal_id" text NOT NULL,
	"outcome_owner_display_name" text,
	"goal" text NOT NULL,
	"constraints" jsonb NOT NULL,
	"acceptance_criteria" jsonb NOT NULL,
	"risk_level" text NOT NULL,
	"deadline" date,
	"policy_summary" text,
	"content_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_targets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"active_target_revision_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verrail_audit_events" ADD CONSTRAINT "verrail_audit_events_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_command_receipts" ADD CONSTRAINT "verrail_command_receipts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_command_receipts" ADD CONSTRAINT "verrail_command_receipts_target_id_verrail_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."verrail_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_command_receipts" ADD CONSTRAINT "verrail_command_receipts_target_revision_id_verrail_target_revisions_id_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."verrail_target_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_outbox_events" ADD CONSTRAINT "verrail_outbox_events_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" ADD CONSTRAINT "verrail_target_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_target_revisions" ADD CONSTRAINT "verrail_target_revisions_target_id_verrail_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."verrail_targets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_audit_events_workspace_occurred_idx" ON "verrail_audit_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "verrail_audit_events_aggregate_idx" ON "verrail_audit_events" USING btree ("aggregate_type","aggregate_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_command_receipts_principal_key_uq" ON "verrail_command_receipts" USING btree ("workspace_id","principal_type","principal_id","command_type","idempotency_key");--> statement-breakpoint
CREATE INDEX "verrail_command_receipts_target_idx" ON "verrail_command_receipts" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "verrail_outbox_events_pending_idx" ON "verrail_outbox_events" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "verrail_outbox_events_aggregate_idx" ON "verrail_outbox_events" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_target_revisions_target_number_uq" ON "verrail_target_revisions" USING btree ("target_id","revision_number");--> statement-breakpoint
CREATE INDEX "verrail_target_revisions_workspace_target_created_idx" ON "verrail_target_revisions" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_targets_workspace_updated_idx" ON "verrail_targets" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "verrail_targets_workspace_project_updated_idx" ON "verrail_targets" USING btree ("workspace_id","project_id","updated_at");