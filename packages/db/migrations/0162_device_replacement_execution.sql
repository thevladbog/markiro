CREATE TABLE "working_device_replacement_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'executing' NOT NULL,
	"step" text DEFAULT 'revoke_pending' NOT NULL,
	"source_credential_epoch" bigint NOT NULL,
	"source_api_key_id" text,
	"facts_fingerprint" text NOT NULL,
	"readiness_report_id" uuid,
	"emergency_reason" text,
	"server_facts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"target_device_id" uuid,
	"offline_authority_until" timestamp with time zone NOT NULL,
	"new_work_allowed_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"credential_revoked_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"response" jsonb,
	"recovery_state" text DEFAULT 'not_required' NOT NULL,
	"recovery_credential_epoch" bigint,
	"recovery_closed_at" timestamp with time zone,
	"recovery_close_reason" text,
	CONSTRAINT "working_device_replacement_executions_preparation_uq" UNIQUE("tenant_id","preparation_id"),
	CONSTRAINT "working_device_replacement_executions_request_uq" UNIQUE("tenant_id","actor_domain","request_id"),
	CONSTRAINT "working_device_replacement_executions_target_uq" UNIQUE("tenant_id","target_device_id"),
	CONSTRAINT "working_device_replacement_executions_identity_check" CHECK ("working_device_replacement_executions"."revision" > 0 and "working_device_replacement_executions"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_executions"."actor_id")) between 1 and 256 and "working_device_replacement_executions"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_replacement_executions"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and "working_device_replacement_executions"."source_credential_epoch" between 1 and 9007199254740991 and ("working_device_replacement_executions"."target_device_id" is null or "working_device_replacement_executions"."target_device_id" <> "working_device_replacement_executions"."device_id") and ("working_device_replacement_executions"."source_api_key_id" is null or length(btrim("working_device_replacement_executions"."source_api_key_id")) between 1 and 256)),
	CONSTRAINT "working_device_replacement_executions_mode_check" CHECK ((("working_device_replacement_executions"."mode" = 'normal' and "working_device_replacement_executions"."readiness_report_id" is not null and "working_device_replacement_executions"."emergency_reason" is null and "working_device_replacement_executions"."recovery_state" = 'not_required') or ("working_device_replacement_executions"."mode" = 'emergency' and "working_device_replacement_executions"."emergency_reason" is not null and length(btrim("working_device_replacement_executions"."emergency_reason")) between 1 and 1000 and "working_device_replacement_executions"."recovery_state" in ('required','draining','completed','evidence_unavailable'))) is true),
	CONSTRAINT "working_device_replacement_executions_step_check" CHECK ((("working_device_replacement_executions"."state" = 'executing' and "working_device_replacement_executions"."target_device_id" is null and "working_device_replacement_executions"."executed_at" is null and "working_device_replacement_executions"."response" is null and (("working_device_replacement_executions"."step" = 'revoke_pending' and "working_device_replacement_executions"."credential_revoked_at" is null) or ("working_device_replacement_executions"."step" = 'credential_revoked' and "working_device_replacement_executions"."credential_revoked_at" is not null))) or ("working_device_replacement_executions"."state" = 'completed' and "working_device_replacement_executions"."step" = 'transferred' and "working_device_replacement_executions"."target_device_id" is not null and "working_device_replacement_executions"."credential_revoked_at" is not null and "working_device_replacement_executions"."executed_at" is not null and "working_device_replacement_executions"."response" is not null)) is true),
	CONSTRAINT "working_device_replacement_executions_interval_check" CHECK (isfinite("working_device_replacement_executions"."started_at") and isfinite("working_device_replacement_executions"."offline_authority_until") and isfinite("working_device_replacement_executions"."new_work_allowed_at") and "working_device_replacement_executions"."new_work_allowed_at" >= "working_device_replacement_executions"."offline_authority_until" and ("working_device_replacement_executions"."credential_revoked_at" is null or (isfinite("working_device_replacement_executions"."credential_revoked_at") and "working_device_replacement_executions"."credential_revoked_at" >= "working_device_replacement_executions"."started_at")) and ("working_device_replacement_executions"."executed_at" is null or (isfinite("working_device_replacement_executions"."executed_at") and "working_device_replacement_executions"."executed_at" >= "working_device_replacement_executions"."credential_revoked_at"))),
	CONSTRAINT "working_device_replacement_executions_payload_check" CHECK (jsonb_typeof("working_device_replacement_executions"."server_facts") = 'object' and octet_length("working_device_replacement_executions"."server_facts"::text) <= 262144 and ("working_device_replacement_executions"."response" is null or (jsonb_typeof("working_device_replacement_executions"."response") = 'object' and octet_length("working_device_replacement_executions"."response"::text) <= 262144))),
	CONSTRAINT "working_device_replacement_executions_recovery_check" CHECK ((("working_device_replacement_executions"."recovery_state" in ('not_required','required','draining') and "working_device_replacement_executions"."recovery_closed_at" is null and "working_device_replacement_executions"."recovery_close_reason" is null) or ("working_device_replacement_executions"."recovery_state" in ('completed','evidence_unavailable') and "working_device_replacement_executions"."state" = 'completed' and "working_device_replacement_executions"."recovery_closed_at" is not null and isfinite("working_device_replacement_executions"."recovery_closed_at") and "working_device_replacement_executions"."recovery_closed_at" >= "working_device_replacement_executions"."executed_at" and (("working_device_replacement_executions"."recovery_state" = 'completed' and "working_device_replacement_executions"."recovery_close_reason" is null) or ("working_device_replacement_executions"."recovery_state" = 'evidence_unavailable' and "working_device_replacement_executions"."recovery_close_reason" is not null and length(btrim("working_device_replacement_executions"."recovery_close_reason")) between 1 and 1000)))) and ("working_device_replacement_executions"."recovery_credential_epoch" is null or ("working_device_replacement_executions"."mode" = 'emergency' and "working_device_replacement_executions"."recovery_credential_epoch" > "working_device_replacement_executions"."source_credential_epoch" and "working_device_replacement_executions"."recovery_credential_epoch" <= 9007199254740991)))
);
--> statement-breakpoint
CREATE TABLE "working_device_replacement_readiness_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"actor_domain" text NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" text NOT NULL,
	"credential_epoch" bigint NOT NULL,
	"preparation_revision" integer NOT NULL,
	"assignment_revision" integer NOT NULL,
	"entitlement_revision" bigint NOT NULL,
	"usage_revision" bigint NOT NULL,
	"grant_configuration_id" uuid,
	"grant_configuration_sequence" bigint,
	"facts_fingerprint" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"response" jsonb,
	CONSTRAINT "working_device_replacement_intents_identity_uq" UNIQUE("tenant_id","device_id","preparation_id","id","credential_epoch"),
	CONSTRAINT "working_device_replacement_intents_request_uq" UNIQUE("tenant_id","actor_domain","request_id"),
	CONSTRAINT "working_device_replacement_intents_identity_check" CHECK ("working_device_replacement_readiness_intents"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_readiness_intents"."actor_id")) between 1 and 256 and "working_device_replacement_readiness_intents"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_replacement_readiness_intents"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and "working_device_replacement_readiness_intents"."credential_epoch" between 1 and 9007199254740991 and "working_device_replacement_readiness_intents"."preparation_revision" > 0 and "working_device_replacement_readiness_intents"."assignment_revision" > 0 and "working_device_replacement_readiness_intents"."entitlement_revision" >= 0 and "working_device_replacement_readiness_intents"."usage_revision" >= 0 and (("working_device_replacement_readiness_intents"."grant_configuration_id" is null and "working_device_replacement_readiness_intents"."grant_configuration_sequence" is null) or ("working_device_replacement_readiness_intents"."grant_configuration_id" is not null and "working_device_replacement_readiness_intents"."grant_configuration_sequence" is not null and "working_device_replacement_readiness_intents"."grant_configuration_sequence" > 0))),
	CONSTRAINT "working_device_replacement_intents_interval_check" CHECK (isfinite("working_device_replacement_readiness_intents"."requested_at") and isfinite("working_device_replacement_readiness_intents"."expires_at") and "working_device_replacement_readiness_intents"."expires_at" > "working_device_replacement_readiness_intents"."requested_at" and (("working_device_replacement_readiness_intents"."state" = 'active' and "working_device_replacement_readiness_intents"."closed_at" is null) or ("working_device_replacement_readiness_intents"."state" in ('superseded','cancelled','completed') and "working_device_replacement_readiness_intents"."closed_at" is not null and isfinite("working_device_replacement_readiness_intents"."closed_at") and "working_device_replacement_readiness_intents"."closed_at" >= "working_device_replacement_readiness_intents"."requested_at"))),
	CONSTRAINT "working_device_replacement_intents_response_check" CHECK ("working_device_replacement_readiness_intents"."response" is null or (jsonb_typeof("working_device_replacement_readiness_intents"."response") = 'object' and octet_length("working_device_replacement_readiness_intents"."response"::text) <= 262144))
);
--> statement-breakpoint
CREATE TABLE "working_device_replacement_readiness_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"device_id" uuid NOT NULL,
	"preparation_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"credential_epoch" bigint NOT NULL,
	"report_sequence" bigint NOT NULL,
	"client_build" text NOT NULL,
	"storage_revision" bigint NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"counters" jsonb NOT NULL,
	"eligibility" jsonb NOT NULL,
	"response" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "working_device_replacement_reports_identity_uq" UNIQUE("tenant_id","device_id","preparation_id","id","credential_epoch"),
	CONSTRAINT "working_device_replacement_reports_request_uq" UNIQUE("tenant_id","request_id"),
	CONSTRAINT "working_device_replacement_reports_sequence_uq" UNIQUE("tenant_id","intent_id","report_sequence"),
	CONSTRAINT "working_device_replacement_reports_identity_check" CHECK ("working_device_replacement_readiness_reports"."credential_epoch" between 1 and 9007199254740991 and "working_device_replacement_readiness_reports"."report_sequence" between 0 and 9007199254740991 and "working_device_replacement_readiness_reports"."storage_revision" between 1 and 9007199254740991 and length(btrim("working_device_replacement_readiness_reports"."client_build")) between 1 and 100 and "working_device_replacement_readiness_reports"."payload_hash" ~ '^[0-9a-f]{64}$' and isfinite("working_device_replacement_readiness_reports"."received_at")),
	CONSTRAINT "working_device_replacement_reports_payload_check" CHECK (jsonb_typeof("working_device_replacement_readiness_reports"."payload") = 'object' and octet_length("working_device_replacement_readiness_reports"."payload"::text) <= 262144 and jsonb_typeof("working_device_replacement_readiness_reports"."response") = 'object' and octet_length("working_device_replacement_readiness_reports"."response"::text) <= 262144 and jsonb_typeof("working_device_replacement_readiness_reports"."counters") = 'object' and octet_length("working_device_replacement_readiness_reports"."counters"::text) <= 4096 and "working_device_replacement_readiness_reports"."counters" ?& array['scans','inventories','shiftClosures','productLabels','boxes','exceptions','conflicts','unknownPrints'] and "working_device_replacement_readiness_reports"."counters" - array['scans','inventories','shiftClosures','productLabels','boxes','exceptions','conflicts','unknownPrints'] = '{}'::jsonb and not jsonb_path_exists("working_device_replacement_readiness_reports"."counters", '$.* ? ((@.type() != "number" && @.type() != "string") || (@.type() == "string" && @ != "unsupported") || (@.type() == "number" && (@ < 0 || @ > 9007199254740991 || @.floor() != @)))')),
	CONSTRAINT "working_device_replacement_reports_eligibility_check" CHECK ((jsonb_typeof("working_device_replacement_readiness_reports"."eligibility") = 'object' and octet_length("working_device_replacement_readiness_reports"."eligibility"::text) <= 4096 and "working_device_replacement_readiness_reports"."eligibility" ?& array['status','reasons'] and "working_device_replacement_readiness_reports"."eligibility" - array['status','reasons'] = '{}'::jsonb and jsonb_typeof("working_device_replacement_readiness_reports"."eligibility"->'reasons') = 'array' and (("working_device_replacement_readiness_reports"."eligibility"->>'status' = 'eligible' and "working_device_replacement_readiness_reports"."eligibility"->'reasons' = '[]'::jsonb) or ("working_device_replacement_readiness_reports"."eligibility"->>'status' = 'blocked' and jsonb_array_length("working_device_replacement_readiness_reports"."eligibility"->'reasons') between 1 and 32))) is true)
);
--> statement-breakpoint
ALTER TABLE "working_device_assignments" DROP CONSTRAINT "working_device_assignments_release_check";--> statement-breakpoint
ALTER TABLE "working_device_events" DROP CONSTRAINT "working_device_events_action_check";--> statement-breakpoint
ALTER TABLE "working_device_events" DROP CONSTRAINT "working_device_events_replacement_check";--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" DROP CONSTRAINT "working_device_replacement_preparations_identity_check";--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" DROP CONSTRAINT "working_device_replacement_preparations_cancellation_check";--> statement-breakpoint
DROP INDEX "working_device_replacements_one_prepared_uq";--> statement-breakpoint
ALTER TABLE "station_pairing_codes" ADD COLUMN "purpose" text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD CONSTRAINT "working_device_replacement_executions_source_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD CONSTRAINT "working_device_replacement_executions_preparation_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id") REFERENCES "public"."working_device_replacement_preparations"("tenant_id","device_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD CONSTRAINT "working_device_replacement_executions_target_fk" FOREIGN KEY ("tenant_id","target_device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD CONSTRAINT "working_device_replacement_executions_report_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id","readiness_report_id","source_credential_epoch") REFERENCES "public"."working_device_replacement_readiness_reports"("tenant_id","device_id","preparation_id","id","credential_epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_readiness_intents" ADD CONSTRAINT "working_device_replacement_intents_source_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_readiness_intents" ADD CONSTRAINT "working_device_replacement_intents_preparation_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id") REFERENCES "public"."working_device_replacement_preparations"("tenant_id","device_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_readiness_intents" ADD CONSTRAINT "working_device_replacement_intents_configuration_fk" FOREIGN KEY ("tenant_id","grant_configuration_id") REFERENCES "public"."device_grant_configurations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_readiness_reports" ADD CONSTRAINT "working_device_replacement_reports_source_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_device_replacement_readiness_reports" ADD CONSTRAINT "working_device_replacement_reports_intent_fk" FOREIGN KEY ("tenant_id","device_id","preparation_id","intent_id","credential_epoch") REFERENCES "public"."working_device_replacement_readiness_intents"("tenant_id","device_id","preparation_id","id","credential_epoch") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "working_device_replacement_executions_repair_idx" ON "working_device_replacement_executions" USING btree ("state","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "working_device_replacement_intents_active_uq" ON "working_device_replacement_readiness_intents" USING btree ("tenant_id","preparation_id") WHERE "working_device_replacement_readiness_intents"."state" = 'active';--> statement-breakpoint
CREATE INDEX "working_device_replacement_reports_received_idx" ON "working_device_replacement_readiness_reports" USING btree ("tenant_id","device_id","received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "working_device_replacements_one_prepared_uq" ON "working_device_replacement_preparations" USING btree ("tenant_id","device_id") WHERE "working_device_replacement_preparations"."state" in ('prepared','draining','ready','executing');--> statement-breakpoint
ALTER TABLE "station_pairing_codes" ADD CONSTRAINT "station_pairing_codes_purpose_check" CHECK ("station_pairing_codes"."purpose" in ('normal','replacement_recovery')) NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_assignments" ADD CONSTRAINT "working_device_assignments_release_check" CHECK (("working_device_assignments"."state" <> 'released' and "working_device_assignments"."released_at" is null and "working_device_assignments"."release_reason" is null) or ("working_device_assignments"."state" = 'released' and "working_device_assignments"."released_at" is not null and "working_device_assignments"."release_reason" is not null and "working_device_assignments"."release_reason" in ('reservation_cancelled','security_revoked','replacement_transferred'))) NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_execution_check" CHECK ("working_device_events"."action" not in ('replacement_drain_requested','replacement_ready','replacement_execution_started','replacement_transferred','replacement_recovery_started','replacement_recovery_completed','replacement_recovery_unavailable') or (("working_device_events"."actor_domain" in ('cabinet','platform','system','device') and "working_device_events"."actor_id" is not null and length(btrim("working_device_events"."actor_id")) between 1 and 256 and "working_device_events"."request_id" is not null and "working_device_events"."request_hash" is not null and "working_device_events"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_events"."response" is not null and jsonb_typeof("working_device_events"."response") = 'object' and "working_device_events"."response"->>'requestId' = "working_device_events"."request_id"::text and "working_device_events"."before" is not null) is true)) NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_action_check" CHECK ("working_device_events"."action" in ('observed','reserved','assigned','released','reservation_cancelled','replacement_prepared','replacement_cancelled','replacement_drain_requested','replacement_ready','replacement_execution_started','replacement_transferred','replacement_recovery_started','replacement_recovery_completed','replacement_recovery_unavailable') and "working_device_events"."outcome" = 'success') NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_events" ADD CONSTRAINT "working_device_events_replacement_check" CHECK ("working_device_events"."action" not in ('replacement_prepared','replacement_cancelled') or (("working_device_events"."actor_domain" in ('cabinet','platform') and "working_device_events"."actor_id" is not null and "working_device_events"."request_id" is not null and "working_device_events"."request_hash" is not null and "working_device_events"."request_hash" ~ '^[0-9a-f]{64}$' and "working_device_events"."response" is not null and jsonb_typeof("working_device_events"."response") = 'object' and "working_device_events"."response"->>'requestId' is not null and "working_device_events"."response"->>'requestId' = "working_device_events"."request_id"::text and "working_device_events"."after"->>'id' is not null and "working_device_events"."response"#>>'{preparation,id}' is not null and "working_device_events"."response"#>>'{preparation,id}' = "working_device_events"."after"->>'id' and (("working_device_events"."action" = 'replacement_prepared' and "working_device_events"."before" is null and "working_device_events"."after"->>'state' = 'prepared' and "working_device_events"."response"#>>'{preparation,state}' = 'prepared') or ("working_device_events"."action" = 'replacement_cancelled' and "working_device_events"."before" is not null and "working_device_events"."before"->>'state' in ('prepared','draining','ready') and "working_device_events"."after"->>'state' = 'cancelled' and "working_device_events"."response"#>>'{preparation,state}' = 'cancelled'))) is true)) NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" ADD CONSTRAINT "working_device_replacement_preparations_identity_check" CHECK ("working_device_replacement_preparations"."state" in ('prepared','draining','ready','executing','completed','cancelled') and "working_device_replacement_preparations"."revision" >= 1 and "working_device_replacement_preparations"."actor_domain" in ('cabinet','platform') and length(btrim("working_device_replacement_preparations"."actor_id")) between 1 and 256 and jsonb_typeof("working_device_replacement_preparations"."observation") = 'object' and "working_device_replacement_preparations"."facts_fingerprint" ~ '^[0-9a-f]{64}$' and isfinite("working_device_replacement_preparations"."prepared_at")) NOT VALID;--> statement-breakpoint
ALTER TABLE "working_device_replacement_preparations" ADD CONSTRAINT "working_device_replacement_preparations_cancellation_check" CHECK ((("working_device_replacement_preparations"."state" <> 'cancelled' and "working_device_replacement_preparations"."cancelled_at" is null and "working_device_replacement_preparations"."cancelled_actor_domain" is null and "working_device_replacement_preparations"."cancelled_actor_id" is null) or ("working_device_replacement_preparations"."state" = 'cancelled' and "working_device_replacement_preparations"."cancelled_at" is not null and isfinite("working_device_replacement_preparations"."cancelled_at") and "working_device_replacement_preparations"."cancelled_at" >= "working_device_replacement_preparations"."prepared_at" and "working_device_replacement_preparations"."cancelled_actor_domain" is not null and "working_device_replacement_preparations"."cancelled_actor_domain" in ('cabinet','platform') and "working_device_replacement_preparations"."cancelled_actor_id" is not null and length(btrim("working_device_replacement_preparations"."cancelled_actor_id")) between 1 and 256)) is true) NOT VALID;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION working_device_replacement_guard_preparation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NOT ((OLD.state = 'prepared' AND NEW.state IN ('draining','executing','cancelled'))
      OR (OLD.state = 'draining' AND NEW.state IN ('draining','ready','executing','cancelled'))
      OR (OLD.state = 'ready' AND NEW.state IN ('draining','executing','cancelled'))
      OR (OLD.state = 'executing' AND NEW.state = 'completed'))
    OR NEW.revision <> OLD.revision + 1
    OR (to_jsonb(NEW) - ARRAY['revision','state','cancelled_at','cancelled_actor_domain','cancelled_actor_id'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','state','cancelled_at','cancelled_actor_domain','cancelled_actor_id']) THEN
    RAISE EXCEPTION 'Invalid working device replacement transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION working_device_replacement_guard_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Working device replacement report is immutable' USING ERRCODE='23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_replacement_reports_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_readiness_reports
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_report();
--> statement-breakpoint
CREATE FUNCTION working_device_replacement_guard_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR OLD.state <> 'active'
    OR (to_jsonb(NEW) - ARRAY['state','closed_at','response'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','closed_at','response'])
    OR (OLD.response IS NOT NULL AND NEW.response IS DISTINCT FROM OLD.response) THEN
    RAISE EXCEPTION 'Working device replacement intent is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_replacement_intents_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_readiness_intents
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_intent();
--> statement-breakpoint
CREATE FUNCTION working_device_replacement_guard_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.revision <> OLD.revision + 1
    OR (to_jsonb(NEW) - ARRAY['revision','state','step','target_device_id','credential_revoked_at','executed_at','response','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','state','step','target_device_id','credential_revoked_at','executed_at','response','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason'])
    OR (OLD.step = 'credential_revoked' AND NEW.step = 'revoke_pending')
    OR (OLD.state = 'completed' AND (to_jsonb(NEW) - ARRAY['revision','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason']))
    OR (OLD.credential_revoked_at IS NOT NULL AND NEW.credential_revoked_at IS DISTINCT FROM OLD.credential_revoked_at)
    OR (OLD.response IS NOT NULL AND NEW.response IS DISTINCT FROM OLD.response)
    OR (OLD.recovery_state IN ('completed','evidence_unavailable') AND NEW IS DISTINCT FROM OLD)
    OR (OLD.recovery_state = 'draining' AND NEW.recovery_state = 'required')
    OR (OLD.recovery_credential_epoch IS NOT NULL AND (NEW.recovery_credential_epoch IS NULL OR NEW.recovery_credential_epoch < OLD.recovery_credential_epoch)) THEN
    RAISE EXCEPTION 'Invalid working device replacement execution transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER working_device_replacement_executions_immutable
BEFORE UPDATE OR DELETE ON working_device_replacement_executions
FOR EACH ROW EXECUTE FUNCTION working_device_replacement_guard_execution();

--> statement-breakpoint
CREATE OR REPLACE FUNCTION working_device_guard_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT EXISTS (SELECT 1 FROM station_devices WHERE tenant_id=OLD.tenant_id AND id=OLD.device_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Working device assignment must be retained' USING ERRCODE='23514';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    RAISE EXCEPTION 'Working device assignment identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.release_reason IN ('reservation_cancelled','replacement_transferred') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Cancelled or transferred assignment is terminal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
