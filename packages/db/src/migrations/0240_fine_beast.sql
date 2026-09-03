CREATE TABLE "verrail_acceptances" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"review_id" uuid NOT NULL,
	"authority" text NOT NULL,
	"accepted_by_principal_type" text NOT NULL,
	"accepted_by_principal_id" text NOT NULL,
	"acceptance_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_acceptances_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_acceptances_submission_uq" UNIQUE("submission_id"),
	CONSTRAINT "verrail_acceptances_authority_check" CHECK ("verrail_acceptances"."authority" = 'outcome_owner'),
	CONSTRAINT "verrail_acceptances_accepted_by_type_check" CHECK ("verrail_acceptances"."accepted_by_principal_type" = 'user')
);
--> statement-breakpoint
CREATE TABLE "verrail_delivery_reviews" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_principal_type" text NOT NULL,
	"reviewer_principal_id" text NOT NULL,
	"verdict" text NOT NULL,
	"risks" text,
	"unproven_items" text[] NOT NULL,
	"comments" text,
	"review_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_delivery_reviews_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_delivery_reviews_verdict_check" CHECK ("verrail_delivery_reviews"."verdict" in ('approved', 'changes_requested', 'rejected')),
	CONSTRAINT "verrail_delivery_reviews_reviewer_type_check" CHECK ("verrail_delivery_reviews"."reviewer_principal_type" = 'user')
);
--> statement-breakpoint
CREATE TABLE "verrail_submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"artifact_revision_ids" uuid[] NOT NULL,
	"verification_result_ids" uuid[] NOT NULL,
	"commit_ref" text,
	"environment_summary" text,
	"notes" text,
	"submission_hash" text NOT NULL,
	"submitted_by_principal_type" text NOT NULL,
	"submitted_by_principal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_submissions_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_submissions_target_hash_uq" UNIQUE("target_id","submission_hash"),
	CONSTRAINT "verrail_submissions_artifact_revision_ids_check" CHECK (coalesce(array_length("verrail_submissions"."artifact_revision_ids", 1), 0) > 0)
);
--> statement-breakpoint
ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_submission_workspace_fk" FOREIGN KEY ("submission_id","workspace_id") REFERENCES "public"."verrail_submissions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_acceptances" ADD CONSTRAINT "verrail_acceptances_review_workspace_fk" FOREIGN KEY ("review_id","workspace_id") REFERENCES "public"."verrail_delivery_reviews"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_delivery_reviews" ADD CONSTRAINT "verrail_delivery_reviews_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_delivery_reviews" ADD CONSTRAINT "verrail_delivery_reviews_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_delivery_reviews" ADD CONSTRAINT "verrail_delivery_reviews_submission_workspace_fk" FOREIGN KEY ("submission_id","workspace_id") REFERENCES "public"."verrail_submissions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_submissions" ADD CONSTRAINT "verrail_submissions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_submissions" ADD CONSTRAINT "verrail_submissions_target_workspace_fk" FOREIGN KEY ("target_id","workspace_id") REFERENCES "public"."verrail_targets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_submissions" ADD CONSTRAINT "verrail_submissions_target_revision_workspace_fk" FOREIGN KEY ("target_revision_id","workspace_id") REFERENCES "public"."verrail_target_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_acceptances_workspace_target_created_idx" ON "verrail_acceptances" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_delivery_reviews_workspace_target_created_idx" ON "verrail_delivery_reviews" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_delivery_reviews_submission_created_idx" ON "verrail_delivery_reviews" USING btree ("submission_id","created_at");--> statement-breakpoint
CREATE INDEX "verrail_submissions_workspace_target_created_idx" ON "verrail_submissions" USING btree ("workspace_id","target_id","created_at");