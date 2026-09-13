CREATE TABLE "device_grant_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"grant_id" uuid,
	"evidence_identity" text NOT NULL,
	"payload_digest" text NOT NULL,
	"payload" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"reason" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_grant_evidence_identity_uq" UNIQUE("tenant_id","evidence_identity"),
	CONSTRAINT "device_grant_evidence_owner_check" CHECK (("device_grant_evidence"."owner_kind" in ('station','handheld') and "device_grant_evidence"."station_device_id" is not null and "device_grant_evidence"."kiosk_id" is null) or ("device_grant_evidence"."owner_kind"='kiosk' and "device_grant_evidence"."kiosk_id" is not null and "device_grant_evidence"."station_device_id" is null)),
	CONSTRAINT "device_grant_evidence_epoch_check" CHECK ("device_grant_evidence"."credential_epoch" > 0),
	CONSTRAINT "device_grant_evidence_payload_check" CHECK ("device_grant_evidence"."payload_digest" ~ '^[0-9a-f]{64}$' and jsonb_typeof("device_grant_evidence"."payload")='object' and octet_length("device_grant_evidence"."payload"::text) <= 1048576 and length(btrim("device_grant_evidence"."evidence_identity")) > 0 and "device_grant_evidence"."disposition" in ('accepted','duplicate','quarantined'))
);
--> statement-breakpoint
CREATE TABLE "device_grant_issuances" (
	"grant_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"kind_of_grant" text NOT NULL,
	"task_source_id" uuid,
	"policy_id" uuid NOT NULL,
	"policy_revision" text NOT NULL,
	"entitlement_revision" text NOT NULL,
	"request_identity" text NOT NULL,
	"header_kid" text NOT NULL,
	"compact_jws" text NOT NULL,
	"payload_digest" text NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"start_not_after" timestamp with time zone,
	"complete_not_after" timestamp with time zone,
	CONSTRAINT "device_grant_issuances_tenant_id_uq" UNIQUE("tenant_id","grant_id"),
	CONSTRAINT "device_grant_issuances_request_uq" UNIQUE("tenant_id","request_identity"),
	CONSTRAINT "device_grant_issuances_owner_check" CHECK (("device_grant_issuances"."owner_kind" in ('station','handheld') and "device_grant_issuances"."station_device_id" is not null and "device_grant_issuances"."kiosk_id" is null) or ("device_grant_issuances"."owner_kind"='kiosk' and "device_grant_issuances"."kiosk_id" is not null and "device_grant_issuances"."station_device_id" is null)),
	CONSTRAINT "device_grant_issuances_epoch_check" CHECK ("device_grant_issuances"."credential_epoch" > 0),
	CONSTRAINT "device_grant_issuances_shape_check" CHECK (("device_grant_issuances"."kind_of_grant"='device' and "device_grant_issuances"."task_source_id" is null and "device_grant_issuances"."start_not_after" > "device_grant_issuances"."issued_at" and "device_grant_issuances"."complete_not_after" is null) or ("device_grant_issuances"."kind_of_grant"='task' and "device_grant_issuances"."task_source_id" is not null and "device_grant_issuances"."complete_not_after" > "device_grant_issuances"."issued_at" and "device_grant_issuances"."start_not_after" is null)),
	CONSTRAINT "device_grant_issuances_payload_check" CHECK ("device_grant_issuances"."payload_digest" ~ '^[0-9a-f]{64}$' and length("device_grant_issuances"."compact_jws") between 1 and 65536 and length(btrim("device_grant_issuances"."header_kid")) > 0 and length(btrim("device_grant_issuances"."request_identity")) > 0 and isfinite("device_grant_issuances"."issued_at") and ("device_grant_issuances"."start_not_after" is null or isfinite("device_grant_issuances"."start_not_after")) and ("device_grant_issuances"."complete_not_after" is null or isfinite("device_grant_issuances"."complete_not_after")))
);
--> statement-breakpoint
CREATE TABLE "device_grant_task_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"task_kind" text NOT NULL,
	"task_id" uuid NOT NULL,
	"snapshot_digest" text NOT NULL,
	"scope" jsonb NOT NULL,
	"event_types" jsonb NOT NULL,
	"budget" jsonb NOT NULL,
	"policy_id" uuid NOT NULL,
	"policy_revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_grant_sources_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_grant_sources_owner_check" CHECK (("device_grant_task_sources"."owner_kind" in ('station','handheld') and "device_grant_task_sources"."station_device_id" is not null and "device_grant_task_sources"."kiosk_id" is null) or ("device_grant_task_sources"."owner_kind"='kiosk' and "device_grant_task_sources"."kiosk_id" is not null and "device_grant_task_sources"."station_device_id" is null)),
	CONSTRAINT "device_grant_sources_epoch_check" CHECK ("device_grant_task_sources"."credential_epoch" > 0),
	CONSTRAINT "device_grant_sources_task_check" CHECK ("device_grant_task_sources"."task_kind" in ('shift','inventory','pickup') and ("device_grant_task_sources"."owner_kind"='kiosk')=("device_grant_task_sources"."task_kind"='pickup')),
	CONSTRAINT "device_grant_sources_payload_check" CHECK ("device_grant_task_sources"."snapshot_digest" ~ '^[0-9a-f]{64}$' and jsonb_typeof("device_grant_task_sources"."scope")='object' and jsonb_typeof("device_grant_task_sources"."event_types")='array' and jsonb_array_length("device_grant_task_sources"."event_types") > 0 and jsonb_typeof("device_grant_task_sources"."budget")='array' and jsonb_array_length("device_grant_task_sources"."budget") > 0)
);
--> statement-breakpoint
ALTER TABLE "station_devices" ADD COLUMN "credential_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "kiosk_order_admissions" ADD COLUMN "frozen_scope" jsonb;--> statement-breakpoint
ALTER TABLE "kiosk_order_admissions" ADD COLUMN "credential_epoch" integer;--> statement-breakpoint
ALTER TABLE "kiosks" ADD COLUMN "credential_epoch" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "station_devices" ADD CONSTRAINT "station_devices_tenant_id_kind_uq" UNIQUE("tenant_id","id","kind");--> statement-breakpoint
ALTER TABLE "device_grant_evidence" ADD CONSTRAINT "device_grant_evidence_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_evidence" ADD CONSTRAINT "device_grant_evidence_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_evidence" ADD CONSTRAINT "device_grant_evidence_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_evidence" ADD CONSTRAINT "device_grant_evidence_issuance_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."device_grant_issuances"("tenant_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_issuances" ADD CONSTRAINT "device_grant_issuances_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_issuances" ADD CONSTRAINT "device_grant_issuances_policy_id_entitlement_lifecycle_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_issuances" ADD CONSTRAINT "device_grant_issuances_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_issuances" ADD CONSTRAINT "device_grant_issuances_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_issuances" ADD CONSTRAINT "device_grant_issuances_source_fk" FOREIGN KEY ("tenant_id","task_source_id") REFERENCES "public"."device_grant_task_sources"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_task_sources" ADD CONSTRAINT "device_grant_task_sources_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_task_sources" ADD CONSTRAINT "device_grant_task_sources_policy_id_entitlement_lifecycle_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."entitlement_lifecycle_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_task_sources" ADD CONSTRAINT "device_grant_sources_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_task_sources" ADD CONSTRAINT "device_grant_sources_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_devices" ADD CONSTRAINT "station_devices_credential_epoch_check" CHECK ("station_devices"."credential_epoch" > 0);--> statement-breakpoint
ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_credential_epoch_check" CHECK ("kiosks"."credential_epoch" > 0);
--> statement-breakpoint
CREATE FUNCTION device_grant_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Offline grant history is immutable' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER device_grant_issuances_immutable BEFORE UPDATE OR DELETE ON device_grant_issuances FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();
--> statement-breakpoint
CREATE TRIGGER device_grant_task_sources_immutable BEFORE UPDATE OR DELETE ON device_grant_task_sources FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();
--> statement-breakpoint
CREATE TRIGGER device_grant_evidence_immutable BEFORE UPDATE OR DELETE ON device_grant_evidence FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();

--> statement-breakpoint
CREATE FUNCTION station_credential_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_epoch IS DISTINCT FROM OLD.credential_epoch THEN
    RAISE EXCEPTION 'Credential epoch is server managed' USING ERRCODE = '23514';
  END IF;
  IF NEW.api_key_id IS DISTINCT FROM OLD.api_key_id OR NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    IF OLD.credential_epoch = 2147483647 THEN
      RAISE EXCEPTION 'Credential epoch exhausted' USING ERRCODE = '23514';
    END IF;
    NEW.credential_epoch := OLD.credential_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER station_credential_epoch_advance BEFORE UPDATE ON station_devices FOR EACH ROW EXECUTE FUNCTION station_credential_epoch_advance();
--> statement-breakpoint
CREATE FUNCTION kiosk_credential_epoch_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.credential_epoch IS DISTINCT FROM OLD.credential_epoch THEN
    RAISE EXCEPTION 'Credential epoch is server managed' USING ERRCODE = '23514';
  END IF;
  IF NEW.device_token_hash IS DISTINCT FROM OLD.device_token_hash THEN
    IF OLD.credential_epoch = 2147483647 THEN
      RAISE EXCEPTION 'Credential epoch exhausted' USING ERRCODE = '23514';
    END IF;
    NEW.credential_epoch := OLD.credential_epoch + 1;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER kiosk_credential_epoch_advance BEFORE UPDATE ON kiosks FOR EACH ROW EXECUTE FUNCTION kiosk_credential_epoch_advance();

--> statement-breakpoint
CREATE FUNCTION device_grant_issuance_source_check() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE frozen device_grant_task_sources%ROWTYPE;
BEGIN
  IF (NEW.kind_of_grant = 'device' AND NEW.start_not_after IS NULL) OR
     (NEW.kind_of_grant = 'task' AND NEW.complete_not_after IS NULL) THEN
    RAISE EXCEPTION 'Grant deadline is required' USING ERRCODE = '23514';
  END IF;
  IF NEW.task_source_id IS NOT NULL THEN
    -- Defer an absent or foreign native owner to the explicit tenant FK.
    IF NEW.station_device_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM station_devices WHERE tenant_id=NEW.tenant_id AND id=NEW.station_device_id AND kind=NEW.owner_kind
    ) THEN RETURN NEW; END IF;
    IF NEW.kiosk_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM kiosks WHERE tenant_id=NEW.tenant_id AND id=NEW.kiosk_id
    ) THEN RETURN NEW; END IF;
    SELECT * INTO frozen FROM device_grant_task_sources WHERE tenant_id=NEW.tenant_id AND id=NEW.task_source_id;
    IF FOUND AND (frozen.owner_kind IS DISTINCT FROM NEW.owner_kind OR
       frozen.station_device_id IS DISTINCT FROM NEW.station_device_id OR
       frozen.kiosk_id IS DISTINCT FROM NEW.kiosk_id OR
       frozen.credential_epoch IS DISTINCT FROM NEW.credential_epoch OR
       frozen.policy_id IS DISTINCT FROM NEW.policy_id OR frozen.policy_revision IS DISTINCT FROM NEW.policy_revision) THEN
      RAISE EXCEPTION 'Grant source owner or policy mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER device_grant_issuance_source_check BEFORE INSERT ON device_grant_issuances FOR EACH ROW EXECUTE FUNCTION device_grant_issuance_source_check();
