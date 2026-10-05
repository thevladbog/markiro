CREATE TABLE "trace_export_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"cycle" integer NOT NULL,
	"token" uuid NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"report_rendered_at" timestamp with time zone,
	"failure_code" text,
	"retryable" boolean DEFAULT false NOT NULL,
	CONSTRAINT "trace_export_attempts_scope_uq" UNIQUE("tenant_id","run_id","id"),
	CONSTRAINT "trace_export_attempts_fence_uq" UNIQUE("tenant_id","run_id","id","token"),
	CONSTRAINT "trace_export_attempts_number_uq" UNIQUE("tenant_id","run_id","attempt_number"),
	CONSTRAINT "trace_export_attempts_token_uq" UNIQUE("token"),
	CONSTRAINT "trace_export_attempts_counts_valid" CHECK ("trace_export_attempts"."attempt_number" > 0 AND "trace_export_attempts"."cycle" > 0),
	CONSTRAINT "trace_export_attempts_times_valid" CHECK ("trace_export_attempts"."lease_expires_at" > "trace_export_attempts"."started_at" AND "trace_export_attempts"."lease_expires_at" <= "trace_export_attempts"."deadline_at" AND "trace_export_attempts"."deadline_at" = "trace_export_attempts"."started_at" + interval '300 seconds' AND ("trace_export_attempts"."finished_at" IS NULL OR "trace_export_attempts"."finished_at" >= "trace_export_attempts"."started_at") AND ("trace_export_attempts"."report_rendered_at" IS NULL OR "trace_export_attempts"."report_rendered_at" >= "trace_export_attempts"."started_at")),
	CONSTRAINT "trace_export_attempts_status_valid" CHECK (("trace_export_attempts"."status" = 'active' AND "trace_export_attempts"."finished_at" IS NULL AND "trace_export_attempts"."failure_code" IS NULL AND NOT "trace_export_attempts"."retryable") OR ("trace_export_attempts"."status" = 'succeeded' AND "trace_export_attempts"."finished_at" IS NOT NULL AND "trace_export_attempts"."failure_code" IS NULL AND NOT "trace_export_attempts"."retryable") OR ("trace_export_attempts"."status" IN ('failed','abandoned') AND "trace_export_attempts"."finished_at" IS NOT NULL AND "trace_export_attempts"."failure_code" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "trace_export_object_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"object_key" text NOT NULL,
	"media_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'allocated' NOT NULL,
	"allocated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_at" timestamp with time zone,
	"fenced_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"referenced_at" timestamp with time zone,
	CONSTRAINT "trace_export_object_intents_key_uq" UNIQUE("object_key"),
	CONSTRAINT "trace_export_object_intents_name_uq" UNIQUE("tenant_id","run_id","attempt_id","name"),
	CONSTRAINT "trace_export_object_intents_file_valid" CHECK (("trace_export_object_intents"."name" = 'records.xlsx' AND "trace_export_object_intents"."kind" = 'xlsx' AND "trace_export_object_intents"."media_type" = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' AND "trace_export_object_intents"."byte_size" <= 16777216) OR ("trace_export_object_intents"."name" = 'plan.pdf' AND "trace_export_object_intents"."kind" = 'plan_pdf' AND "trace_export_object_intents"."media_type" = 'application/pdf' AND "trace_export_object_intents"."byte_size" <= 8000000) OR ("trace_export_object_intents"."name" = 'validation.json' AND "trace_export_object_intents"."kind" = 'validation_report' AND "trace_export_object_intents"."media_type" = 'application/json' AND "trace_export_object_intents"."byte_size" <= 16777216) OR ("trace_export_object_intents"."name" = 'request-report.pdf' AND "trace_export_object_intents"."kind" = 'request_report' AND "trace_export_object_intents"."media_type" = 'application/pdf' AND "trace_export_object_intents"."byte_size" <= 4194304) OR ("trace_export_object_intents"."name" = 'manifest.json' AND "trace_export_object_intents"."kind" = 'manifest' AND "trace_export_object_intents"."media_type" = 'application/json' AND "trace_export_object_intents"."byte_size" <= 1048576) OR ("trace_export_object_intents"."name" = 'package.zip' AND "trace_export_object_intents"."kind" = 'package_zip' AND "trace_export_object_intents"."media_type" = 'application/zip' AND "trace_export_object_intents"."byte_size" <= 67108864)),
	CONSTRAINT "trace_export_object_intents_evidence_valid" CHECK ("trace_export_object_intents"."byte_size" > 0 AND "trace_export_object_intents"."sha256" ~ '^[a-f0-9]{64}$' AND "trace_export_object_intents"."object_key" = 'us/requests/' || "trace_export_object_intents"."tenant_id" || '/' || "trace_export_object_intents"."run_id"::text || '/' || "trace_export_object_intents"."attempt_id"::text || '/' || "trace_export_object_intents"."name"),
	CONSTRAINT "trace_export_object_intents_state_valid" CHECK (("trace_export_object_intents"."state" IN ('allocated','unresolved') AND "trace_export_object_intents"."verified_at" IS NULL AND "trace_export_object_intents"."fenced_at" IS NULL AND "trace_export_object_intents"."deleted_at" IS NULL AND "trace_export_object_intents"."referenced_at" IS NULL) OR ("trace_export_object_intents"."state" = 'verified' AND "trace_export_object_intents"."verified_at" IS NOT NULL AND "trace_export_object_intents"."fenced_at" IS NULL AND "trace_export_object_intents"."deleted_at" IS NULL AND "trace_export_object_intents"."referenced_at" IS NULL) OR ("trace_export_object_intents"."state" = 'fenced' AND "trace_export_object_intents"."fenced_at" IS NOT NULL AND "trace_export_object_intents"."deleted_at" IS NULL AND "trace_export_object_intents"."referenced_at" IS NULL) OR ("trace_export_object_intents"."state" = 'deleted' AND "trace_export_object_intents"."fenced_at" IS NOT NULL AND "trace_export_object_intents"."deleted_at" IS NOT NULL AND "trace_export_object_intents"."referenced_at" IS NULL) OR ("trace_export_object_intents"."state" = 'referenced' AND "trace_export_object_intents"."verified_at" IS NOT NULL AND "trace_export_object_intents"."referenced_at" IS NOT NULL AND "trace_export_object_intents"."fenced_at" IS NULL AND "trace_export_object_intents"."deleted_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "trace_export_render_checkpoints" (
	"tenant_id" text NOT NULL,
	"run_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"model" jsonb NOT NULL,
	"model_digest" text NOT NULL,
	"execution_digest" text NOT NULL,
	"package_version" text NOT NULL,
	"report_version" text NOT NULL,
	"package_expectation" jsonb,
	CONSTRAINT "trace_export_render_checkpoints_scope_uq" UNIQUE("tenant_id","run_id"),
	CONSTRAINT "trace_export_render_checkpoints_body_valid" CHECK (jsonb_typeof("trace_export_render_checkpoints"."model") = 'object' AND octet_length("trace_export_render_checkpoints"."model"::text) <= 1048576 AND ("trace_export_render_checkpoints"."package_expectation" IS NULL OR (jsonb_typeof("trace_export_render_checkpoints"."package_expectation") = 'object' AND octet_length("trace_export_render_checkpoints"."package_expectation"::text) <= 1048576))),
	CONSTRAINT "trace_export_render_checkpoints_digest_valid" CHECK ("trace_export_render_checkpoints"."model_digest" ~ '^[a-f0-9]{64}$' AND "trace_export_render_checkpoints"."execution_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "trace_export_render_checkpoints_versions_valid" CHECK ("trace_export_render_checkpoints"."package_version" = 'us-request-package-v1' AND "trace_export_render_checkpoints"."report_version" = 'us-request-report-pdf-v1')
);
--> statement-breakpoint
CREATE TABLE "trace_export_retry_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"command_digest" text NOT NULL,
	"reason" text NOT NULL,
	"expected_lifecycle_version" integer NOT NULL,
	"cycle" integer NOT NULL,
	"lifecycle_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trace_export_retry_receipts_command_uq" UNIQUE("tenant_id","actor_id","idempotency_key"),
	CONSTRAINT "trace_export_retry_receipts_cycle_uq" UNIQUE("tenant_id","run_id","cycle"),
	CONSTRAINT "trace_export_retry_receipts_valid" CHECK ("trace_export_retry_receipts"."expected_lifecycle_version" >= 0 AND "trace_export_retry_receipts"."lifecycle_version" > "trace_export_retry_receipts"."expected_lifecycle_version" AND "trace_export_retry_receipts"."cycle" > 1 AND "trace_export_retry_receipts"."command_digest" ~ '^[a-f0-9]{64}$' AND char_length(btrim("trace_export_retry_receipts"."reason")) BETWEEN 3 AND 2000 AND "trace_export_retry_receipts"."reason" ~ '[^[:space:]]' AND char_length("trace_export_retry_receipts"."actor_id") > 0)
);
--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "lifecycle_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "retry_cycle" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "cycle_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "lease_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD COLUMN "attempt_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "trace_export_attempts" ADD CONSTRAINT "trace_export_attempts_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."trace_export_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_object_intents" ADD CONSTRAINT "trace_export_object_intents_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."trace_export_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_object_intents" ADD CONSTRAINT "trace_export_object_intents_attempt_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."trace_export_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_render_checkpoints" ADD CONSTRAINT "trace_export_render_checkpoints_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."trace_export_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_render_checkpoints" ADD CONSTRAINT "trace_export_render_checkpoints_attempt_fk" FOREIGN KEY ("tenant_id","run_id","attempt_id") REFERENCES "public"."trace_export_attempts"("tenant_id","run_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_retry_receipts" ADD CONSTRAINT "trace_export_retry_receipts_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."trace_export_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_lease_fk" FOREIGN KEY ("tenant_id","id","lease_attempt_id","lease_token") REFERENCES "public"."trace_export_attempts"("tenant_id","run_id","id","token") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_worker_counts_valid" CHECK ("trace_export_runs"."attempt_count" >= 0 AND "trace_export_runs"."lifecycle_version" >= 0 AND "trace_export_runs"."retry_cycle" > 0 AND "trace_export_runs"."cycle_attempt_count" BETWEEN 0 AND 3 AND "trace_export_runs"."cycle_attempt_count" <= "trace_export_runs"."attempt_count");--> statement-breakpoint
ALTER TABLE "trace_export_runs" ADD CONSTRAINT "trace_export_runs_worker_lease_valid" CHECK (("trace_export_runs"."lease_attempt_id" IS NULL AND "trace_export_runs"."lease_token" IS NULL AND "trace_export_runs"."lease_expires_at" IS NULL AND "trace_export_runs"."attempt_deadline_at" IS NULL) OR ("trace_export_runs"."status" = 'processing' AND "trace_export_runs"."lease_attempt_id" IS NOT NULL AND "trace_export_runs"."lease_token" IS NOT NULL AND "trace_export_runs"."lease_expires_at" IS NOT NULL AND "trace_export_runs"."attempt_deadline_at" IS NOT NULL AND "trace_export_runs"."lease_expires_at" <= "trace_export_runs"."attempt_deadline_at" AND "trace_export_runs"."cycle_attempt_count" > 0));
--> statement-breakpoint
-- JSONB equality permits equivalent object-key ordering; saved content is immutable.
CREATE FUNCTION us_request_worker_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'immutable request run' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW) - ARRAY['status','export_ready','failure_code','generation_started_at','report_rendered_at','completed_at','attempt_count','lifecycle_version','retry_cycle','cycle_attempt_count','next_attempt_at','lease_attempt_id','lease_token','lease_expires_at','attempt_deadline_at'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','export_ready','failure_code','generation_started_at','report_rendered_at','completed_at','attempt_count','lifecycle_version','retry_cycle','cycle_attempt_count','next_attempt_at','lease_attempt_id','lease_token','lease_expires_at','attempt_deadline_at'])
     OR NEW.attempt_count < OLD.attempt_count OR NEW.lifecycle_version < OLD.lifecycle_version
     OR NEW.retry_cycle < OLD.retry_cycle OR NEW.retry_cycle > OLD.retry_cycle + 1
     OR (OLD.status = 'ready' AND NEW IS DISTINCT FROM OLD)
     OR (NEW.retry_cycle = OLD.retry_cycle AND NEW.cycle_attempt_count < OLD.cycle_attempt_count)
     OR (NEW.retry_cycle <> OLD.retry_cycle AND NOT (OLD.status='failed' AND NEW.status='queued' AND NEW.cycle_attempt_count=0))
     OR (OLD.status='failed' AND NEW.status NOT IN ('failed','queued'))
     OR (OLD.status='failed' AND NEW.status='queued' AND NEW.retry_cycle <> OLD.retry_cycle+1)
     OR (OLD.status='queued' AND NEW.status='ready')
  THEN RAISE EXCEPTION 'invalid request run transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER us_request_worker_run_guard BEFORE UPDATE OR DELETE ON trace_export_runs FOR EACH ROW EXECUTE FUNCTION us_request_worker_run_guard();
--> statement-breakpoint
CREATE FUNCTION us_request_worker_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable worker evidence' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME IN ('trace_export_artifacts','trace_export_retry_receipts') THEN
    RAISE EXCEPTION 'immutable published evidence' USING ERRCODE='23514';
  ELSIF TG_TABLE_NAME='trace_export_render_checkpoints' THEN
    IF (to_jsonb(NEW)-'package_expectation') IS DISTINCT FROM (to_jsonb(OLD)-'package_expectation')
       OR (OLD.package_expectation IS NOT NULL AND NEW.package_expectation IS DISTINCT FROM OLD.package_expectation)
    THEN RAISE EXCEPTION 'immutable render checkpoint' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='trace_export_attempts' THEN
    IF (to_jsonb(NEW)-ARRAY['status','lease_expires_at','finished_at','report_rendered_at','failure_code','retryable']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','lease_expires_at','finished_at','report_rendered_at','failure_code','retryable'])
       OR (OLD.status <> 'active' AND NEW IS DISTINCT FROM OLD)
       OR NEW.lease_expires_at < OLD.lease_expires_at
       OR (OLD.report_rendered_at IS NOT NULL AND NEW.report_rendered_at IS DISTINCT FROM OLD.report_rendered_at)
    THEN RAISE EXCEPTION 'immutable attempt evidence' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='trace_export_object_intents' THEN
    IF (to_jsonb(NEW)-ARRAY['state','verified_at','fenced_at','deleted_at','referenced_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','verified_at','fenced_at','deleted_at','referenced_at'])
       OR (OLD.fenced_at IS NOT NULL AND NEW.fenced_at IS DISTINCT FROM OLD.fenced_at)
       OR (OLD.verified_at IS NOT NULL AND NEW.verified_at IS DISTINCT FROM OLD.verified_at)
       OR (OLD.state IN ('deleted','referenced') AND NEW IS DISTINCT FROM OLD)
       OR (OLD.state='fenced' AND NEW.state NOT IN ('fenced','deleted'))
       OR (OLD.state='verified' AND NEW.state NOT IN ('verified','fenced','referenced'))
    THEN RAISE EXCEPTION 'immutable object evidence or fence' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER us_request_worker_artifact_guard BEFORE UPDATE OR DELETE ON trace_export_artifacts FOR EACH ROW EXECUTE FUNCTION us_request_worker_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER us_request_worker_attempt_guard BEFORE UPDATE OR DELETE ON trace_export_attempts FOR EACH ROW EXECUTE FUNCTION us_request_worker_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER us_request_worker_checkpoint_guard BEFORE UPDATE OR DELETE ON trace_export_render_checkpoints FOR EACH ROW EXECUTE FUNCTION us_request_worker_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER us_request_worker_intent_guard BEFORE UPDATE OR DELETE ON trace_export_object_intents FOR EACH ROW EXECUTE FUNCTION us_request_worker_evidence_guard();
--> statement-breakpoint
CREATE TRIGGER us_request_worker_retry_guard BEFORE UPDATE OR DELETE ON trace_export_retry_receipts FOR EACH ROW EXECUTE FUNCTION us_request_worker_evidence_guard();
