ALTER TABLE "support_chat_proposals" ADD COLUMN "operator_access_audit_ids" jsonb;
--> statement-breakpoint
CREATE FUNCTION support_chat_proposal_access_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.operator_access_audit_ids IS NULL OR
     jsonb_typeof(NEW.operator_access_audit_ids) <> 'array' THEN
    RAISE EXCEPTION 'new support proposal requires an operator access snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_proposals_access_snapshot';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER support_chat_proposals_access_snapshot
  BEFORE INSERT ON support_chat_proposals
  FOR EACH ROW EXECUTE FUNCTION support_chat_proposal_access_snapshot_guard();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION support_chat_proposal_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.episode_id, NEW.revision, NEW.title,
         NEW.summary, NEW.notice_version, NEW.operator_id, NEW.operator_access_audit_ids,
         NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.episode_id, OLD.revision, OLD.title,
         OLD.summary, OLD.notice_version, OLD.operator_id, OLD.operator_access_audit_ids,
         OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'support proposal facts are immutable; create a new revision'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_proposals_facts_immutable';
  END IF;
  RETURN NEW;
END;
$$;
