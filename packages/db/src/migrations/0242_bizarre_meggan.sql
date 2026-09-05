CREATE TABLE "verrail_human_work_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"work_node_id" uuid NOT NULL,
	"submitted_by_principal_type" text NOT NULL,
	"submitted_by_principal_id" text NOT NULL,
	"input_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"artifact_revision_id" uuid,
	"attachment_hashes" text[] DEFAULT '{}'::text[] NOT NULL,
	"result_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_human_work_results_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_human_work_results_submitter_type_check" CHECK ("verrail_human_work_results"."submitted_by_principal_type" = 'user'),
	CONSTRAINT "verrail_human_work_results_input_hash_check" CHECK ("verrail_human_work_results"."input_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verrail_human_work_results_result_hash_check" CHECK ("verrail_human_work_results"."result_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "verrail_integration_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"integration_run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"connector_version" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"provider_ref" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"provider_receipt" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_integration_attempts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_integration_attempts_number_check" CHECK ("verrail_integration_attempts"."attempt_number" > 0),
	CONSTRAINT "verrail_integration_attempts_status_check" CHECK ("verrail_integration_attempts"."status" in ('succeeded', 'failed', 'neutral'))
);
--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "target_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "graph_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "connector_version" text;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "connection_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "commit_ref" text;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "criterion_key" text;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "environment_ref" text;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "provider_receipt" jsonb;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_graph_workspace_fk" FOREIGN KEY ("graph_revision_id","workspace_id") REFERENCES "public"."verrail_graph_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_node_workspace_fk" FOREIGN KEY ("work_node_id","workspace_id") REFERENCES "public"."verrail_work_nodes"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_human_work_results" ADD CONSTRAINT "verrail_human_work_results_artifact_revision_workspace_fk" FOREIGN KEY ("artifact_revision_id","workspace_id") REFERENCES "public"."verrail_artifact_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_attempts" ADD CONSTRAINT "verrail_integration_attempts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_attempts" ADD CONSTRAINT "verrail_integration_attempts_run_workspace_fk" FOREIGN KEY ("integration_run_id","workspace_id") REFERENCES "public"."verrail_integration_runs"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_attempts" ADD CONSTRAINT "verrail_integration_attempts_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_human_work_results_principal_idempotency_uq" ON "verrail_human_work_results" USING btree ("workspace_id","submitted_by_principal_type","submitted_by_principal_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "verrail_human_work_results_node_created_idx" ON "verrail_human_work_results" USING btree ("work_node_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_integration_attempts_run_number_uq" ON "verrail_integration_attempts" USING btree ("integration_run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_integration_attempts_connection_idempotency_uq" ON "verrail_integration_attempts" USING btree ("workspace_id","connection_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_graph_workspace_fk" FOREIGN KEY ("graph_revision_id","workspace_id") REFERENCES "public"."verrail_graph_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_integration_runs_workspace_idempotency_uq" ON "verrail_integration_runs" USING btree ("workspace_id","idempotency_key") WHERE "verrail_integration_runs"."idempotency_key" is not null;