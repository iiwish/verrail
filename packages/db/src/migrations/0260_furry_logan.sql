CREATE TABLE "verrail_repository_dispatches" (
	"run_attempt_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"fencing_token" integer NOT NULL,
	"controller_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'dispatched' NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error_code" text,
	"controller_expires_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_repository_dispatch_status_check" CHECK ("verrail_repository_dispatches"."status" in ('dispatched', 'succeeded', 'failed', 'canceled', 'interrupted')),
	CONSTRAINT "verrail_repository_dispatch_terminal_check" CHECK (("verrail_repository_dispatches"."status" <> 'dispatched') = ("verrail_repository_dispatches"."finished_at" is not null)),
	CONSTRAINT "verrail_repository_dispatch_budget_check" CHECK ("verrail_repository_dispatches"."tool_calls" between 0 and 20 and "verrail_repository_dispatches"."fencing_token" > 0),
	CONSTRAINT "verrail_repository_dispatch_hash_check" CHECK ("verrail_repository_dispatches"."request_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "verrail_repository_dispatches" ADD CONSTRAINT "verrail_repository_dispatch_attempt_fk" FOREIGN KEY ("run_attempt_id","run_id","workspace_id") REFERENCES "public"."verrail_run_attempts"("id","run_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_repository_dispatches" ADD CONSTRAINT "verrail_repository_dispatch_lease_fk" FOREIGN KEY ("lease_id","workspace_id") REFERENCES "public"."verrail_execution_leases"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "verrail_repository_dispatch_recovery_idx" ON "verrail_repository_dispatches" USING btree ("status","controller_expires_at");