CREATE TYPE "public"."support_chat_delivery" AS ENUM('pending', 'sent', 'uncertain', 'failed');--> statement-breakpoint
CREATE TYPE "public"."support_chat_direction" AS ENUM('customer', 'operator');--> statement-breakpoint
CREATE TYPE "public"."support_chat_job_kind" AS ENUM('send', 'reconcile', 'import');--> statement-breakpoint
CREATE TYPE "public"."support_chat_job_state" AS ENUM('pending', 'leased', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."support_chat_proposal_state" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
ALTER TYPE "public"."billing_request_type" ADD VALUE 'support';--> statement-breakpoint
CREATE TABLE "support_chat_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"episode_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"user_id" text NOT NULL,
	"decision" text NOT NULL,
	"notice_version" text NOT NULL,
	"accepted_title" text NOT NULL,
	"accepted_summary" text NOT NULL,
	"operator_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"snapshot_through" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_consents_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_consents_proposal_revision_uq" UNIQUE("proposal_id","revision"),
	CONSTRAINT "support_chat_consents_episode_key_uq" UNIQUE("tenant_id","episode_id","idempotency_key"),
	CONSTRAINT "support_chat_consents_decision" CHECK ("support_chat_consents"."decision" in ('accept', 'decline')),
	CONSTRAINT "support_chat_consents_notice_version" CHECK ("support_chat_consents"."notice_version" = 'support-transcript-v1')
);
--> statement-breakpoint
CREATE TABLE "support_chat_episodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"creation_key" uuid NOT NULL,
	"remote_account_id" integer,
	"remote_inbox_id" integer,
	"remote_conversation_id" integer,
	"request_id" uuid,
	"transcript_state" text DEFAULT 'pending' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_episodes_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_episodes_owner_creation_uq" UNIQUE("tenant_id","owner_id","creation_key"),
	CONSTRAINT "support_chat_episodes_request_uq" UNIQUE("request_id"),
	CONSTRAINT "support_chat_episodes_remote_uq" UNIQUE("remote_account_id","remote_inbox_id","remote_conversation_id"),
	CONSTRAINT "support_chat_episodes_remote_message_scope_uq" UNIQUE("tenant_id","id","remote_account_id","remote_inbox_id","remote_conversation_id"),
	CONSTRAINT "support_chat_episodes_remote_shape" CHECK (("support_chat_episodes"."remote_account_id" is null and "support_chat_episodes"."remote_inbox_id" is null and "support_chat_episodes"."remote_conversation_id" is null) or ("support_chat_episodes"."remote_account_id" is not null and "support_chat_episodes"."remote_inbox_id" is not null and "support_chat_episodes"."remote_conversation_id" is not null)),
	CONSTRAINT "support_chat_episodes_remote_positive" CHECK (("support_chat_episodes"."remote_account_id" is null or "support_chat_episodes"."remote_account_id" > 0) and ("support_chat_episodes"."remote_inbox_id" is null or "support_chat_episodes"."remote_inbox_id" > 0) and ("support_chat_episodes"."remote_conversation_id" is null or "support_chat_episodes"."remote_conversation_id" > 0)),
	CONSTRAINT "support_chat_episodes_transcript_state" CHECK ("support_chat_episodes"."transcript_state" in ('pending', 'healthy', 'error'))
);
--> statement-breakpoint
CREATE TABLE "support_chat_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"episode_id" uuid NOT NULL,
	"kind" "support_chat_job_kind" NOT NULL,
	"state" "support_chat_job_state" DEFAULT 'pending' NOT NULL,
	"message_id" uuid,
	"attempt_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpoint" jsonb,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_jobs_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_jobs_retry_nonnegative" CHECK ("support_chat_jobs"."retry_count" >= 0),
	CONSTRAINT "support_chat_jobs_lease_shape" CHECK (("support_chat_jobs"."state" = 'leased' and "support_chat_jobs"."attempt_token" is not null and "support_chat_jobs"."lease_expires_at" is not null) or ("support_chat_jobs"."state" <> 'leased' and "support_chat_jobs"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE "support_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"episode_id" uuid NOT NULL,
	"direction" "support_chat_direction" NOT NULL,
	"text" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"delivery" "support_chat_delivery" NOT NULL,
	"idempotency_key" uuid,
	"remote_account_id" integer,
	"remote_inbox_id" integer,
	"remote_conversation_id" integer,
	"remote_message_id" integer,
	"imported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_messages_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_messages_tenant_episode_id_uq" UNIQUE("tenant_id","episode_id","id"),
	CONSTRAINT "support_chat_messages_tenant_episode_key_uq" UNIQUE("tenant_id","episode_id","idempotency_key"),
	CONSTRAINT "support_chat_messages_remote_uq" UNIQUE("remote_account_id","remote_inbox_id","remote_conversation_id","remote_message_id"),
	CONSTRAINT "support_chat_messages_text_nonempty" CHECK (char_length("support_chat_messages"."text") > 0),
	CONSTRAINT "support_chat_messages_remote_shape" CHECK (("support_chat_messages"."remote_account_id" is null and "support_chat_messages"."remote_inbox_id" is null and "support_chat_messages"."remote_conversation_id" is null and "support_chat_messages"."remote_message_id" is null) or ("support_chat_messages"."remote_account_id" is not null and "support_chat_messages"."remote_inbox_id" is not null and "support_chat_messages"."remote_conversation_id" is not null and "support_chat_messages"."remote_message_id" is not null)),
	CONSTRAINT "support_chat_messages_sent_remote" CHECK ("support_chat_messages"."delivery" <> 'sent' or "support_chat_messages"."remote_message_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "support_chat_owners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"remote_contact_id" text,
	"remote_contact_source_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_owners_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_owners_tenant_user_uq" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "support_chat_owners_remote_contact_shape" CHECK (("support_chat_owners"."remote_contact_id" is null) = ("support_chat_owners"."remote_contact_source_id" is null))
);
--> statement-breakpoint
CREATE TABLE "support_chat_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"episode_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"notice_version" text DEFAULT 'support-transcript-v1' NOT NULL,
	"state" "support_chat_proposal_state" DEFAULT 'pending' NOT NULL,
	"operator_id" text NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_chat_proposals_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "support_chat_proposals_episode_revision_uq" UNIQUE("tenant_id","episode_id","revision"),
	CONSTRAINT "support_chat_proposals_tenant_episode_revision_id_uq" UNIQUE("tenant_id","episode_id","revision","id"),
	CONSTRAINT "support_chat_proposals_episode_key_uq" UNIQUE("tenant_id","episode_id","idempotency_key"),
	CONSTRAINT "support_chat_proposals_revision_positive" CHECK ("support_chat_proposals"."revision" > 0),
	CONSTRAINT "support_chat_proposals_title_length" CHECK (char_length("support_chat_proposals"."title") between 1 and 200),
	CONSTRAINT "support_chat_proposals_summary_length" CHECK (char_length("support_chat_proposals"."summary") between 1 and 4000),
	CONSTRAINT "support_chat_proposals_notice_version" CHECK ("support_chat_proposals"."notice_version" = 'support-transcript-v1')
);
--> statement-breakpoint
ALTER TABLE "support_chat_consents" ADD CONSTRAINT "support_chat_consents_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_consents" ADD CONSTRAINT "support_chat_consents_operator_id_platform_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_consents" ADD CONSTRAINT "support_chat_consents_tenant_episode_fk" FOREIGN KEY ("tenant_id","episode_id") REFERENCES "public"."support_chat_episodes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_consents" ADD CONSTRAINT "support_chat_consents_tenant_proposal_fk" FOREIGN KEY ("tenant_id","episode_id","revision","proposal_id") REFERENCES "public"."support_chat_proposals"("tenant_id","episode_id","revision","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_episodes" ADD CONSTRAINT "support_chat_episodes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_episodes" ADD CONSTRAINT "support_chat_episodes_tenant_owner_fk" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "public"."support_chat_owners"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_episodes" ADD CONSTRAINT "support_chat_episodes_tenant_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."tenant_billing_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_jobs" ADD CONSTRAINT "support_chat_jobs_tenant_episode_fk" FOREIGN KEY ("tenant_id","episode_id") REFERENCES "public"."support_chat_episodes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_jobs" ADD CONSTRAINT "support_chat_jobs_tenant_message_fk" FOREIGN KEY ("tenant_id","episode_id","message_id") REFERENCES "public"."support_chat_messages"("tenant_id","episode_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_messages" ADD CONSTRAINT "support_chat_messages_tenant_episode_fk" FOREIGN KEY ("tenant_id","episode_id") REFERENCES "public"."support_chat_episodes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_messages" ADD CONSTRAINT "support_chat_messages_remote_episode_fk" FOREIGN KEY ("tenant_id","episode_id","remote_account_id","remote_inbox_id","remote_conversation_id") REFERENCES "public"."support_chat_episodes"("tenant_id","id","remote_account_id","remote_inbox_id","remote_conversation_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_owners" ADD CONSTRAINT "support_chat_owners_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_owners" ADD CONSTRAINT "support_chat_owners_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_proposals" ADD CONSTRAINT "support_chat_proposals_operator_id_platform_users_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."platform_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_chat_proposals" ADD CONSTRAINT "support_chat_proposals_tenant_episode_fk" FOREIGN KEY ("tenant_id","episode_id") REFERENCES "public"."support_chat_episodes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "support_chat_episodes_owner_created_idx" ON "support_chat_episodes" USING btree ("tenant_id","owner_id","created_at","id");--> statement-breakpoint
CREATE INDEX "support_chat_jobs_due_idx" ON "support_chat_jobs" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "support_chat_messages_episode_occurred_idx" ON "support_chat_messages" USING btree ("tenant_id","episode_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "support_chat_proposals_one_pending_uq" ON "support_chat_proposals" USING btree ("tenant_id","episode_id") WHERE "support_chat_proposals"."state" = 'pending';--> statement-breakpoint
-- Drizzle models the tables above; these update/insert guards are deliberately hand-authored.
CREATE FUNCTION support_chat_owner_remote_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.remote_contact_id IS NOT NULL AND
     (NEW.remote_contact_id IS DISTINCT FROM OLD.remote_contact_id OR
      NEW.remote_contact_source_id IS DISTINCT FROM OLD.remote_contact_source_id) THEN
    RAISE EXCEPTION 'established support contact identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_owners_remote_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER support_chat_owners_remote_immutable
  BEFORE UPDATE OF remote_contact_id, remote_contact_source_id ON support_chat_owners
  FOR EACH ROW EXECUTE FUNCTION support_chat_owner_remote_identity_guard();--> statement-breakpoint
CREATE FUNCTION support_chat_episode_remote_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.remote_account_id IS NOT NULL AND
     (NEW.remote_account_id IS DISTINCT FROM OLD.remote_account_id OR
      NEW.remote_inbox_id IS DISTINCT FROM OLD.remote_inbox_id OR
      NEW.remote_conversation_id IS DISTINCT FROM OLD.remote_conversation_id) THEN
    RAISE EXCEPTION 'established support conversation identity is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_episodes_remote_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER support_chat_episodes_remote_immutable
  BEFORE UPDATE OF remote_account_id, remote_inbox_id, remote_conversation_id ON support_chat_episodes
  FOR EACH ROW EXECUTE FUNCTION support_chat_episode_remote_identity_guard();--> statement-breakpoint
CREATE FUNCTION support_chat_proposal_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.tenant_id, NEW.episode_id, NEW.revision, NEW.title,
         NEW.summary, NEW.notice_version, NEW.operator_id, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     ROW(OLD.id, OLD.tenant_id, OLD.episode_id, OLD.revision, OLD.title,
         OLD.summary, OLD.notice_version, OLD.operator_id, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'support proposal facts are immutable; create a new revision'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_proposals_facts_immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER support_chat_proposals_facts_immutable
  BEFORE UPDATE ON support_chat_proposals
  FOR EACH ROW EXECUTE FUNCTION support_chat_proposal_facts_guard();--> statement-breakpoint
CREATE FUNCTION support_chat_consent_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_proposal support_chat_proposals%ROWTYPE;
  source_user_id text;
BEGIN
  SELECT p.* INTO source_proposal
    FROM support_chat_proposals p
    WHERE p.id = NEW.proposal_id AND p.tenant_id = NEW.tenant_id
      AND p.episode_id = NEW.episode_id AND p.revision = NEW.revision
    FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'support consent proposal is missing'
      USING ERRCODE = '23503', CONSTRAINT = 'support_chat_consents_tenant_proposal_fk';
  END IF;
  SELECT o.user_id INTO source_user_id
    FROM support_chat_episodes e
    JOIN support_chat_owners o ON o.tenant_id = e.tenant_id AND o.id = e.owner_id
    WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.episode_id
    FOR SHARE OF e, o;
  IF source_user_id IS DISTINCT FROM NEW.user_id OR
     source_proposal.title IS DISTINCT FROM NEW.accepted_title OR
     source_proposal.summary IS DISTINCT FROM NEW.accepted_summary OR
     source_proposal.notice_version IS DISTINCT FROM NEW.notice_version OR
     source_proposal.operator_id IS DISTINCT FROM NEW.operator_id OR
     (NEW.decision = 'accept' AND NEW.snapshot_through IS NULL) THEN
    RAISE EXCEPTION 'support consent does not match its proposal and owner snapshot'
      USING ERRCODE = '23514', CONSTRAINT = 'support_chat_consents_snapshot_match';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER support_chat_consents_snapshot_match
  BEFORE INSERT ON support_chat_consents
  FOR EACH ROW EXECUTE FUNCTION support_chat_consent_insert_guard();--> statement-breakpoint
CREATE FUNCTION support_chat_consent_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'support consent facts are append-only'
    USING ERRCODE = '23514', CONSTRAINT = 'support_chat_consents_append_only';
END;
$$;--> statement-breakpoint
CREATE TRIGGER support_chat_consents_append_only
  BEFORE UPDATE OR DELETE ON support_chat_consents
  FOR EACH ROW EXECUTE FUNCTION support_chat_consent_append_only_guard();
