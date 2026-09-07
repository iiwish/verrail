CREATE TABLE "verrail_criterion_proofs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"graph_revision_id" uuid NOT NULL,
	"criterion_key" text NOT NULL,
	"requirement_id" text NOT NULL,
	"phase" text NOT NULL,
	"contract_hash" text NOT NULL,
	"submission_id" uuid,
	"effect_receipt_id" uuid,
	"verification_result_id" uuid NOT NULL,
	"integration_run_id" uuid NOT NULL,
	"context_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_criterion_proofs_result_uq" UNIQUE("verification_result_id"),
	CONSTRAINT "verrail_criterion_proofs_phase_check" CHECK (("verrail_criterion_proofs"."phase"='pre_acceptance' and "verrail_criterion_proofs"."submission_id" is null and "verrail_criterion_proofs"."effect_receipt_id" is null) or ("verrail_criterion_proofs"."phase"='post_effect' and "verrail_criterion_proofs"."submission_id" is not null and "verrail_criterion_proofs"."effect_receipt_id" is not null)),
	CONSTRAINT "verrail_criterion_proofs_hash_check" CHECK ("verrail_criterion_proofs"."contract_hash" ~ '^[0-9a-f]{64}$' and "verrail_criterion_proofs"."context_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_target_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_revision_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_graph_fk" FOREIGN KEY ("graph_revision_id","workspace_id") REFERENCES "public"."verrail_graph_revisions"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_submission_fk" FOREIGN KEY ("submission_id","workspace_id") REFERENCES "public"."verrail_submissions"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_effect_fk" FOREIGN KEY ("effect_receipt_id","workspace_id") REFERENCES "public"."verrail_effect_receipts"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_result_fk" FOREIGN KEY ("verification_result_id","workspace_id") REFERENCES "public"."verrail_verification_results"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_criterion_proofs" ADD CONSTRAINT "verrail_criterion_proofs_integration_fk" FOREIGN KEY ("integration_run_id","workspace_id") REFERENCES "public"."verrail_integration_runs"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_criterion_proofs_lookup_idx" ON "verrail_criterion_proofs" USING btree ("workspace_id","target_id","target_revision_id","criterion_key","requirement_id","created_at");