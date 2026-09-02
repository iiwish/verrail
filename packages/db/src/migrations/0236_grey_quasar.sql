CREATE TABLE "verrail_agent_command_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text NOT NULL,
	"command_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verrail_agent_definitions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"compatibility_agent_id" uuid,
	"name" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_agent_definitions_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_agent_definitions_status_check" CHECK ("verrail_agent_definitions"."status" in ('draft', 'published', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "verrail_agent_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_definition_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"runtime" text NOT NULL,
	"model" text NOT NULL,
	"prompt" text NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capability_ceiling" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"supply_chain" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_agent_versions_id_workspace_uq" UNIQUE("id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "verrail_deployment_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"deployment_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"evaluation_run_id" uuid NOT NULL,
	"state" text NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_deployment_revisions_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_deployment_revisions_state_check" CHECK ("verrail_deployment_revisions"."state" in ('active', 'paused', 'superseded', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "verrail_deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_definition_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_deployments_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_deployments_status_check" CHECK ("verrail_deployments"."status" in ('active', 'paused', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "verrail_evaluation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"candidate_agent_version_id" uuid NOT NULL,
	"baseline_agent_version_id" uuid,
	"status" text NOT NULL,
	"quality_score" integer,
	"cost_cents" integer,
	"latency_ms" integer,
	"safety_status" text NOT NULL,
	"summary" text,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_evaluation_runs_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_evaluation_runs_status_check" CHECK ("verrail_evaluation_runs"."status" in ('passed', 'failed', 'inconclusive')),
	CONSTRAINT "verrail_evaluation_runs_safety_check" CHECK ("verrail_evaluation_runs"."safety_status" in ('passed', 'failed', 'not_run'))
);
--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD COLUMN "deployment_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD COLUMN "agent_version_id" uuid;--> statement-breakpoint
ALTER TABLE "verrail_agent_command_receipts" ADD CONSTRAINT "verrail_agent_command_receipts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_agent_definitions" ADD CONSTRAINT "verrail_agent_definitions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_agent_definitions" ADD CONSTRAINT "verrail_agent_definitions_compatibility_agent_id_agents_id_fk" FOREIGN KEY ("compatibility_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_agent_versions" ADD CONSTRAINT "verrail_agent_versions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_agent_versions" ADD CONSTRAINT "verrail_agent_versions_definition_workspace_fk" FOREIGN KEY ("agent_definition_id","workspace_id") REFERENCES "public"."verrail_agent_definitions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployment_revisions" ADD CONSTRAINT "verrail_deployment_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployment_revisions" ADD CONSTRAINT "verrail_deployment_revisions_deployment_workspace_fk" FOREIGN KEY ("deployment_id","workspace_id") REFERENCES "public"."verrail_deployments"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployment_revisions" ADD CONSTRAINT "verrail_deployment_revisions_version_workspace_fk" FOREIGN KEY ("agent_version_id","workspace_id") REFERENCES "public"."verrail_agent_versions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployment_revisions" ADD CONSTRAINT "verrail_deployment_revisions_evaluation_workspace_fk" FOREIGN KEY ("evaluation_run_id","workspace_id") REFERENCES "public"."verrail_evaluation_runs"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployments" ADD CONSTRAINT "verrail_deployments_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_deployments" ADD CONSTRAINT "verrail_deployments_definition_workspace_fk" FOREIGN KEY ("agent_definition_id","workspace_id") REFERENCES "public"."verrail_agent_definitions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_evaluation_runs" ADD CONSTRAINT "verrail_evaluation_runs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_evaluation_runs" ADD CONSTRAINT "verrail_evaluation_runs_candidate_workspace_fk" FOREIGN KEY ("candidate_agent_version_id","workspace_id") REFERENCES "public"."verrail_agent_versions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_evaluation_runs" ADD CONSTRAINT "verrail_evaluation_runs_baseline_workspace_fk" FOREIGN KEY ("baseline_agent_version_id","workspace_id") REFERENCES "public"."verrail_agent_versions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_agent_command_receipts_key_uq" ON "verrail_agent_command_receipts" USING btree ("workspace_id","principal_type","principal_id","command_type","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_agent_definitions_workspace_name_uq" ON "verrail_agent_definitions" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_agent_definitions_compat_agent_uq" ON "verrail_agent_definitions" USING btree ("compatibility_agent_id");--> statement-breakpoint
CREATE INDEX "verrail_agent_definitions_workspace_updated_idx" ON "verrail_agent_definitions" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_agent_versions_definition_number_uq" ON "verrail_agent_versions" USING btree ("agent_definition_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_agent_versions_definition_hash_uq" ON "verrail_agent_versions" USING btree ("agent_definition_id","content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_deployment_revisions_deployment_number_uq" ON "verrail_deployment_revisions" USING btree ("deployment_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_deployments_workspace_name_uq" ON "verrail_deployments" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_deployments_workspace_default_uq" ON "verrail_deployments" USING btree ("workspace_id") WHERE "verrail_deployments"."is_default";--> statement-breakpoint
CREATE INDEX "verrail_evaluation_runs_candidate_created_idx" ON "verrail_evaluation_runs" USING btree ("candidate_agent_version_id","created_at");--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD CONSTRAINT "verrail_runs_deployment_revision_workspace_fk" FOREIGN KEY ("deployment_revision_id","workspace_id") REFERENCES "public"."verrail_deployment_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD CONSTRAINT "verrail_runs_agent_version_workspace_fk" FOREIGN KEY ("agent_version_id","workspace_id") REFERENCES "public"."verrail_agent_versions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;