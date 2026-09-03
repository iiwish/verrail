CREATE TABLE "verrail_artifact_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"artifact_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"content_hash" text NOT NULL,
	"content_ref" text NOT NULL,
	"source_run_id" uuid,
	"source_work_node_id" uuid,
	"base_revision_id" uuid,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_artifact_revisions_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_artifact_revisions_revision_number_check" CHECK ("verrail_artifact_revisions"."revision_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "verrail_artifacts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_artifacts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_artifacts_kind_check" CHECK ("verrail_artifacts"."kind" in ('code_change', 'document', 'report', 'external_reference'))
);
--> statement-breakpoint
CREATE TABLE "verrail_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"criterion_key" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_claims_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_claims_criterion_key_check" CHECK (char_length("verrail_claims"."criterion_key") between 1 and 100),
	CONSTRAINT "verrail_claims_status_check" CHECK ("verrail_claims"."status" in ('open', 'supported', 'refuted', 'waived'))
);
--> statement-breakpoint
CREATE TABLE "verrail_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"claim_id" uuid,
	"kind" text NOT NULL,
	"producer_principal_type" text NOT NULL,
	"producer_principal_id" text NOT NULL,
	"object_hash" text NOT NULL,
	"reference" text NOT NULL,
	"trust_level" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_evidence_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_evidence_kind_check" CHECK ("verrail_evidence"."kind" in ('ci_result', 'scan_result', 'human_review', 'agent_observation', 'external_reference')),
	CONSTRAINT "verrail_evidence_producer_type_check" CHECK ("verrail_evidence"."producer_principal_type" in ('user', 'service', 'agent')),
	CONSTRAINT "verrail_evidence_trust_level_check" CHECK ("verrail_evidence"."trust_level" in ('high', 'medium', 'low')),
	CONSTRAINT "verrail_evidence_agent_trust_check" CHECK ("verrail_evidence"."producer_principal_type" <> 'agent' or ("verrail_evidence"."kind" = 'agent_observation' and "verrail_evidence"."trust_level" = 'low'))
);
--> statement-breakpoint
CREATE TABLE "verrail_verification_results" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"claim_id" uuid NOT NULL,
	"verdict" text NOT NULL,
	"verifier_version" text NOT NULL,
	"evidence_ids" uuid[] NOT NULL,
	"waiver_reference" text,
	"result_hash" text NOT NULL,
	"created_by_principal_type" text NOT NULL,
	"created_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_verification_results_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_verification_results_verdict_check" CHECK ("verrail_verification_results"."verdict" in ('passed', 'failed', 'inconclusive', 'waived')),
	CONSTRAINT "verrail_verification_results_evidence_check" CHECK ("verrail_verification_results"."verdict" = 'waived' or coalesce(array_length("verrail_verification_results"."evidence_ids", 1), 0) > 0),
	CONSTRAINT "verrail_verification_results_waiver_check" CHECK (("verrail_verification_results"."verdict" = 'waived') = ("verrail_verification_results"."waiver_reference" is not null))
);
--> statement-breakpoint
ALTER TABLE "verrail_artifact_revisions" ADD CONSTRAINT "verrail_artifact_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifact_revisions" ADD CONSTRAINT "verrail_artifact_revisions_artifact_workspace_fk" FOREIGN KEY ("artifact_id","workspace_id") REFERENCES "public"."verrail_artifacts"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifact_revisions" ADD CONSTRAINT "verrail_artifact_revisions_run_workspace_fk" FOREIGN KEY ("source_run_id","workspace_id") REFERENCES "public"."verrail_runs"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifact_revisions" ADD CONSTRAINT "verrail_artifact_revisions_work_node_workspace_fk" FOREIGN KEY ("source_work_node_id","workspace_id") REFERENCES "public"."verrail_work_nodes"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifact_revisions" ADD CONSTRAINT "verrail_artifact_revisions_base_revision_workspace_fk" FOREIGN KEY ("base_revision_id","workspace_id") REFERENCES "public"."verrail_artifact_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifacts" ADD CONSTRAINT "verrail_artifacts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_artifacts" ADD CONSTRAINT "verrail_artifacts_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_claims" ADD CONSTRAINT "verrail_claims_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_claims" ADD CONSTRAINT "verrail_claims_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_evidence" ADD CONSTRAINT "verrail_evidence_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_evidence" ADD CONSTRAINT "verrail_evidence_claim_workspace_fk" FOREIGN KEY ("claim_id","workspace_id") REFERENCES "public"."verrail_claims"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_verification_results" ADD CONSTRAINT "verrail_verification_results_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_verification_results" ADD CONSTRAINT "verrail_verification_results_claim_workspace_fk" FOREIGN KEY ("claim_id","workspace_id") REFERENCES "public"."verrail_claims"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_artifact_revisions_artifact_number_uq" ON "verrail_artifact_revisions" USING btree ("artifact_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_artifact_revisions_artifact_hash_uq" ON "verrail_artifact_revisions" USING btree ("artifact_id","content_hash");--> statement-breakpoint
CREATE INDEX "verrail_artifacts_workspace_target_created_idx" ON "verrail_artifacts" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_claims_target_revision_criterion_open_uq" ON "verrail_claims" USING btree ("target_revision_id","criterion_key") WHERE "verrail_claims"."status" = 'open';--> statement-breakpoint
CREATE INDEX "verrail_claims_workspace_target_created_idx" ON "verrail_claims" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_evidence_workspace_target_recorded_idx" ON "verrail_evidence" USING btree ("workspace_id","target_id","recorded_at");--> statement-breakpoint
CREATE INDEX "verrail_evidence_claim_recorded_idx" ON "verrail_evidence" USING btree ("claim_id","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_verification_results_claim_hash_uq" ON "verrail_verification_results" USING btree ("claim_id","result_hash");--> statement-breakpoint
CREATE INDEX "verrail_verification_results_workspace_target_created_idx" ON "verrail_verification_results" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_verification_results_claim_created_idx" ON "verrail_verification_results" USING btree ("claim_id","created_at");