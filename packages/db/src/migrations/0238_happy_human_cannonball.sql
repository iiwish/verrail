CREATE TABLE "verrail_execution_command_receipts" (
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
CREATE TABLE "verrail_execution_leases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_attempt_id" uuid NOT NULL,
	"executor_principal_id" text NOT NULL,
	"runtime_profile" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"grace_expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_heartbeat_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_execution_leases_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_execution_leases_status_check" CHECK ("verrail_execution_leases"."status" in ('offered', 'active', 'suspect', 'expired', 'released', 'revoked')),
	CONSTRAINT "verrail_execution_leases_runtime_profile_check" CHECK ("verrail_execution_leases"."runtime_profile" in ('host_trusted')),
	CONSTRAINT "verrail_execution_leases_positive_fence_check" CHECK ("verrail_execution_leases"."fencing_token" > 0)
);
--> statement-breakpoint
CREATE TABLE "verrail_run_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"deployment_revision_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"runtime_profile" text NOT NULL,
	"executor_principal_type" text NOT NULL,
	"executor_principal_id" text NOT NULL,
	"fencing_token" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_event_cursor" bigint DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"result" jsonb,
	"idempotency_key" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_run_attempts_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_run_attempts_id_run_workspace_uq" UNIQUE("id","run_id","workspace_id"),
	CONSTRAINT "verrail_run_attempts_status_check" CHECK ("verrail_run_attempts"."status" in ('pending', 'running', 'cancel_requested', 'cancel_acknowledged', 'succeeded', 'failed', 'canceled', 'superseded')),
	CONSTRAINT "verrail_run_attempts_runtime_profile_check" CHECK ("verrail_run_attempts"."runtime_profile" in ('host_trusted')),
	CONSTRAINT "verrail_run_attempts_executor_type_check" CHECK ("verrail_run_attempts"."executor_principal_type" in ('service')),
	CONSTRAINT "verrail_run_attempts_positive_attempt_check" CHECK ("verrail_run_attempts"."attempt_number" > 0 and "verrail_run_attempts"."fencing_token" > 0)
);
--> statement-breakpoint
CREATE TABLE "verrail_run_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_attempt_id" uuid NOT NULL,
	"cursor" bigint NOT NULL,
	"fencing_token" bigint NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"emitted_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verrail_run_events_id_workspace_uq" UNIQUE("id","workspace_id"),
	CONSTRAINT "verrail_run_events_type_check" CHECK ("verrail_run_events"."event_type" in ('claimed', 'heartbeat', 'started', 'progress', 'succeeded', 'failed', 'cancel_acknowledged', 'terminated')),
	CONSTRAINT "verrail_run_events_positive_cursor_check" CHECK ("verrail_run_events"."cursor" > 0 and "verrail_run_events"."fencing_token" > 0)
);
--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "verrail_execution_command_receipts" ADD CONSTRAINT "verrail_execution_command_receipts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_execution_leases" ADD CONSTRAINT "verrail_execution_leases_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_runs" ADD CONSTRAINT "verrail_runs_id_workspace_uq" UNIQUE("id","workspace_id");--> statement-breakpoint
ALTER TABLE "verrail_execution_leases" ADD CONSTRAINT "verrail_execution_leases_attempt_run_workspace_fk" FOREIGN KEY ("run_attempt_id","run_id","workspace_id") REFERENCES "public"."verrail_run_attempts"("id","run_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_attempts" ADD CONSTRAINT "verrail_run_attempts_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_attempts" ADD CONSTRAINT "verrail_run_attempts_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."verrail_runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_attempts" ADD CONSTRAINT "verrail_run_attempts_deployment_revision_workspace_fk" FOREIGN KEY ("deployment_revision_id","workspace_id") REFERENCES "public"."verrail_deployment_revisions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_attempts" ADD CONSTRAINT "verrail_run_attempts_agent_version_workspace_fk" FOREIGN KEY ("agent_version_id","workspace_id") REFERENCES "public"."verrail_agent_versions"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_events" ADD CONSTRAINT "verrail_run_events_workspace_id_companies_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verrail_run_events" ADD CONSTRAINT "verrail_run_events_attempt_run_workspace_fk" FOREIGN KEY ("run_attempt_id","run_id","workspace_id") REFERENCES "public"."verrail_run_attempts"("id","run_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_execution_command_receipts_key_uq" ON "verrail_execution_command_receipts" USING btree ("workspace_id","principal_type","principal_id","command_type","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_execution_leases_attempt_uq" ON "verrail_execution_leases" USING btree ("run_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_execution_leases_active_run_uq" ON "verrail_execution_leases" USING btree ("run_id") WHERE "verrail_execution_leases"."status" in ('offered', 'active', 'suspect');--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_run_attempts_run_number_uq" ON "verrail_run_attempts" USING btree ("run_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_run_attempts_run_fence_uq" ON "verrail_run_attempts" USING btree ("run_id","fencing_token");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_run_attempts_run_idempotency_uq" ON "verrail_run_attempts" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "verrail_run_events_attempt_cursor_uq" ON "verrail_run_events" USING btree ("run_attempt_id","cursor");--> statement-breakpoint
CREATE INDEX "verrail_run_events_run_received_idx" ON "verrail_run_events" USING btree ("workspace_id","run_id","received_at");--> statement-breakpoint
