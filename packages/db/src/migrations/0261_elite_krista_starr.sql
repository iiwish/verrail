CREATE TABLE "verrail_run_sources" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_source_revision_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verrail_run_sources" ADD CONSTRAINT "verrail_run_sources_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."verrail_runs"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_sources" ADD CONSTRAINT "verrail_run_sources_revision_workspace_fk" FOREIGN KEY ("repository_source_revision_id","workspace_id") REFERENCES "public"."verrail_artifact_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;