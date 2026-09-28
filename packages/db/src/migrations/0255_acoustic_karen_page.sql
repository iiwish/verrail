ALTER TABLE "verrail_targets" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD COLUMN "archive_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "verrail_targets_workspace_archive_updated_idx" ON "verrail_targets" USING btree ("workspace_id","archived_at","updated_at");--> statement-breakpoint
ALTER TABLE "verrail_targets" ADD CONSTRAINT "verrail_targets_archive_version_check" CHECK ("verrail_targets"."archive_version" >= 0);