CREATE TABLE "target_projection_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"target_revision_id" uuid NOT NULL,
	"projection_policy_version" text NOT NULL,
	"source_revision_key" text NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"schema_version" text DEFAULT '1' NOT NULL,
	"projection" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "target_projection_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"projection_policy_version" text NOT NULL,
	"eligibility_reason" text NOT NULL,
	"active_target_revision_id" uuid NOT NULL,
	"source_revision_key" text NOT NULL,
	"source_snapshot_hash" text NOT NULL,
	"last_projected_at" timestamp with time zone NOT NULL,
	"disabled_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "target_projection_sources_source_type_check" CHECK ("target_projection_sources"."source_type" in ('case', 'issue')),
	CONSTRAINT "target_projection_sources_eligibility_check" CHECK ("target_projection_sources"."eligibility_reason" in ('explicit_marker', 'approved_backfill', 'operator_mapping'))
);
--> statement-breakpoint
ALTER TABLE "target_projection_revisions" ADD CONSTRAINT "target_projection_revisions_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "target_projection_sources" ADD CONSTRAINT "target_projection_sources_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "target_projection_revisions_target_revision_uq" ON "target_projection_revisions" USING btree ("target_revision_id");--> statement-breakpoint
CREATE INDEX "target_projection_revisions_workspace_target_created_idx" ON "target_projection_revisions" USING btree ("workspace_id","target_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "target_projection_sources_workspace_source_uq" ON "target_projection_sources" USING btree ("workspace_id","source_type","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "target_projection_sources_workspace_target_uq" ON "target_projection_sources" USING btree ("workspace_id","target_id");--> statement-breakpoint
CREATE INDEX "target_projection_sources_workspace_active_idx" ON "target_projection_sources" USING btree ("workspace_id","disabled_at","updated_at");