ALTER TABLE "working_device_replacement_executions" ADD COLUMN "repair_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD COLUMN "last_repair_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD COLUMN "next_repair_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "replacement_executions_due_repair_idx" ON "working_device_replacement_executions" USING btree (coalesce("next_repair_at", "started_at"),"started_at","id") WHERE "working_device_replacement_executions"."state" = 'executing';--> statement-breakpoint
ALTER TABLE "working_device_replacement_executions" ADD CONSTRAINT "replacement_executions_repair_check" CHECK ((("working_device_replacement_executions"."repair_attempts" = 0 and "working_device_replacement_executions"."last_repair_at" is null and "working_device_replacement_executions"."next_repair_at" is null) or ("working_device_replacement_executions"."repair_attempts" > 0 and "working_device_replacement_executions"."last_repair_at" is not null and "working_device_replacement_executions"."next_repair_at" is not null and isfinite("working_device_replacement_executions"."last_repair_at") and isfinite("working_device_replacement_executions"."next_repair_at") and "working_device_replacement_executions"."last_repair_at" >= "working_device_replacement_executions"."started_at" and "working_device_replacement_executions"."next_repair_at" >= "working_device_replacement_executions"."last_repair_at")) is true);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION working_device_replacement_guard_execution() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW.revision <> OLD.revision + 1
    OR (to_jsonb(NEW) - ARRAY['revision','state','step','target_device_id','credential_revoked_at','executed_at','response','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason','repair_attempts','last_repair_at','next_repair_at'])
       IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['revision','state','step','target_device_id','credential_revoked_at','executed_at','response','recovery_state','recovery_credential_epoch','recovery_closed_at','recovery_close_reason','repair_attempts','last_repair_at','next_repair_at'])
    OR NEW.repair_attempts < OLD.repair_attempts
    OR (OLD.last_repair_at IS NOT NULL AND (NEW.last_repair_at IS NULL OR NEW.last_repair_at < OLD.last_repair_at))
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
