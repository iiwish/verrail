CREATE TABLE "verrail_action_approvals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"action_request_id" uuid NOT NULL,
	"approved_by_principal_type" text NOT NULL,
	"approved_by_principal_id" text NOT NULL,
	"params_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_action_approvals_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_action_approvals_action_request_uq" UNIQUE("action_request_id"),
	CONSTRAINT "verrail_action_approvals_approver_type_check" CHECK ("verrail_action_approvals"."approved_by_principal_type" = 'user'),
	CONSTRAINT "verrail_action_approvals_params_hash_check" CHECK ("verrail_action_approvals"."params_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "verrail_action_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"params" jsonb NOT NULL,
	"params_hash" text NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"requested_by_principal_type" text NOT NULL,
	"requested_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_action_requests_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_action_requests_action_type_check" CHECK ("verrail_action_requests"."action_type" = 'create_pull_request'),
	CONSTRAINT "verrail_action_requests_status_check" CHECK ("verrail_action_requests"."status" in ('pending_approval', 'approved', 'executed')),
	CONSTRAINT "verrail_action_requests_params_keys_check" CHECK ("verrail_action_requests"."params" ? 'title' and "verrail_action_requests"."params" ? 'head' and "verrail_action_requests"."params" ? 'base'),
	CONSTRAINT "verrail_action_requests_params_hash_check" CHECK ("verrail_action_requests"."params_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "verrail_effect_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"action_request_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"provider" text NOT NULL,
	"external_object_id" text NOT NULL,
	"external_url" text NOT NULL,
	"effect_hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_effect_receipts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_effect_receipts_action_type_check" CHECK ("verrail_effect_receipts"."action_type" = 'create_pull_request'),
	CONSTRAINT "verrail_effect_receipts_provider_check" CHECK ("verrail_effect_receipts"."provider" = 'github'),
	CONSTRAINT "verrail_effect_receipts_effect_hash_check" CHECK ("verrail_effect_receipts"."effect_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "verrail_github_repo_bindings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"repo_owner" text NOT NULL,
	"repo_name" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_github_repo_bindings_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_github_repo_bindings_workspace_uq" UNIQUE("workspace_id"),
	CONSTRAINT "verrail_github_repo_bindings_repo_owner_check" CHECK (char_length("verrail_github_repo_bindings"."repo_owner") between 1 and 200),
	CONSTRAINT "verrail_github_repo_bindings_repo_name_check" CHECK (char_length("verrail_github_repo_bindings"."repo_name") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "verrail_integration_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"work_node_id" uuid,
	"provider" text NOT NULL,
	"external_ref" text NOT NULL,
	"conclusion" text NOT NULL,
	"evidence_id" uuid NOT NULL,
	"verification_result_id" uuid,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_integration_runs_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_integration_runs_provider_check" CHECK ("verrail_integration_runs"."provider" = 'github'),
	CONSTRAINT "verrail_integration_runs_conclusion_check" CHECK ("verrail_integration_runs"."conclusion" in ('success', 'failure', 'neutral')),
	CONSTRAINT "verrail_integration_runs_verification_conclusion_check" CHECK (("verrail_integration_runs"."conclusion" in ('success', 'failure') and "verrail_integration_runs"."verification_result_id" is not null)
        or ("verrail_integration_runs"."conclusion" = 'neutral' and "verrail_integration_runs"."verification_result_id" is null))
);
--> statement-breakpoint
ALTER TABLE "verrail_action_approvals" ADD CONSTRAINT "verrail_action_approvals_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_action_approvals" ADD CONSTRAINT "verrail_action_approvals_action_request_workspace_fk" FOREIGN KEY ("action_request_id","workspace_id") REFERENCES "public"."verrail_action_requests"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_action_requests" ADD CONSTRAINT "verrail_action_requests_submission_workspace_fk" FOREIGN KEY ("submission_id","workspace_id") REFERENCES "public"."verrail_submissions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_effect_receipts" ADD CONSTRAINT "verrail_effect_receipts_action_request_workspace_fk" FOREIGN KEY ("action_request_id","workspace_id") REFERENCES "public"."verrail_action_requests"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_github_repo_bindings" ADD CONSTRAINT "verrail_github_repo_bindings_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_github_repo_bindings" ADD CONSTRAINT "verrail_github_repo_bindings_connection_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."tool_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_claim_workspace_fk" FOREIGN KEY ("claim_id","workspace_id") REFERENCES "public"."verrail_claims"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_work_node_workspace_fk" FOREIGN KEY ("work_node_id","workspace_id") REFERENCES "public"."verrail_work_nodes"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_evidence_workspace_fk" FOREIGN KEY ("evidence_id","workspace_id") REFERENCES "public"."verrail_evidence"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_integration_runs" ADD CONSTRAINT "verrail_integration_runs_verification_result_workspace_fk" FOREIGN KEY ("verification_result_id","workspace_id") REFERENCES "public"."verrail_verification_results"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_action_requests_workspace_target_created_idx" ON "verrail_action_requests" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_action_requests_submission_created_idx" ON "verrail_action_requests" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_effect_receipts_workspace_target_created_idx" ON "verrail_effect_receipts" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_integration_runs_workspace_target_created_idx" ON "verrail_integration_runs" USING btree ("workspace_id","target_id","created_at");