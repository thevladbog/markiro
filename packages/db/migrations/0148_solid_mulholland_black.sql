CREATE TABLE "device_grant_consumption" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"identity" text NOT NULL,
	"task_kind" text NOT NULL,
	"task_id" uuid NOT NULL,
	"snapshot_digest" text NOT NULL,
	"budget_line_id" text NOT NULL,
	"consumed" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "device_grant_consumption_identity_uq" UNIQUE("tenant_id","identity"),
	CONSTRAINT "device_grant_consumption_owner_check" CHECK (("device_grant_consumption"."owner_kind" in ('station','handheld') and "device_grant_consumption"."station_device_id" is not null and "device_grant_consumption"."kiosk_id" is null) or ("device_grant_consumption"."owner_kind"='kiosk' and "device_grant_consumption"."kiosk_id" is not null and "device_grant_consumption"."station_device_id" is null)),
	CONSTRAINT "device_grant_consumption_epoch_check" CHECK ("device_grant_consumption"."credential_epoch" > 0),
	CONSTRAINT "device_grant_consumption_shape_check" CHECK ("device_grant_consumption"."identity" ~ '^[0-9a-f]{64}$' and "device_grant_consumption"."snapshot_digest" ~ '^[0-9a-f]{64}$' and "device_grant_consumption"."task_kind" in ('shift','inventory','pickup') and length(btrim("device_grant_consumption"."budget_line_id")) > 0 and "device_grant_consumption"."consumed" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "device_grant_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"identity" text NOT NULL,
	"payload_digest" text NOT NULL,
	"receipt_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"task_kind" text NOT NULL,
	"task_id" uuid NOT NULL,
	"snapshot_digest" text NOT NULL,
	"event_type" text NOT NULL,
	"cost" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_grant_effects_identity_uq" UNIQUE("tenant_id","identity"),
	CONSTRAINT "device_grant_effects_owner_check" CHECK (("device_grant_effects"."owner_kind" in ('station','handheld') and "device_grant_effects"."station_device_id" is not null and "device_grant_effects"."kiosk_id" is null) or ("device_grant_effects"."owner_kind"='kiosk' and "device_grant_effects"."kiosk_id" is not null and "device_grant_effects"."station_device_id" is null)),
	CONSTRAINT "device_grant_effects_epoch_check" CHECK ("device_grant_effects"."credential_epoch" > 0),
	CONSTRAINT "device_grant_effects_shape_check" CHECK ("device_grant_effects"."identity" ~ '^[0-9a-f]{64}$' and "device_grant_effects"."payload_digest" ~ '^[0-9a-f]{64}$' and "device_grant_effects"."snapshot_digest" ~ '^[0-9a-f]{64}$' and "device_grant_effects"."task_kind" in ('shift','inventory','pickup') and jsonb_typeof("device_grant_effects"."cost")='object' and isfinite("device_grant_effects"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "device_grant_ingest_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"owner_kind" text NOT NULL,
	"station_device_id" uuid,
	"kiosk_id" uuid,
	"credential_epoch" integer NOT NULL,
	"identity" text NOT NULL,
	"operation" text NOT NULL,
	"batch_id" text NOT NULL,
	"payload_digest" text NOT NULL,
	"envelope_digest" text NOT NULL,
	"transport_digest" text NOT NULL,
	"retained_payload" jsonb NOT NULL,
	"mode" text NOT NULL,
	"configuration_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"final_response" jsonb,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "device_grant_ingest_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "device_grant_ingest_identity_uq" UNIQUE("tenant_id","identity"),
	CONSTRAINT "device_grant_ingest_owner_check" CHECK (("device_grant_ingest_receipts"."owner_kind" in ('station','handheld') and "device_grant_ingest_receipts"."station_device_id" is not null and "device_grant_ingest_receipts"."kiosk_id" is null) or ("device_grant_ingest_receipts"."owner_kind"='kiosk' and "device_grant_ingest_receipts"."kiosk_id" is not null and "device_grant_ingest_receipts"."station_device_id" is null)),
	CONSTRAINT "device_grant_ingest_epoch_check" CHECK ("device_grant_ingest_receipts"."credential_epoch" > 0),
	CONSTRAINT "device_grant_ingest_shape_check" CHECK ("device_grant_ingest_receipts"."identity" ~ '^[0-9a-f]{64}$' and "device_grant_ingest_receipts"."payload_digest" ~ '^[0-9a-f]{64}$' and "device_grant_ingest_receipts"."envelope_digest" ~ '^[0-9a-f]{64}$' and "device_grant_ingest_receipts"."transport_digest" ~ '^[0-9a-f]{64}$' and "device_grant_ingest_receipts"."mode" in ('observe','strict') and jsonb_typeof("device_grant_ingest_receipts"."retained_payload")='object' and octet_length("device_grant_ingest_receipts"."retained_payload"::text) <= 4194304 and isfinite("device_grant_ingest_receipts"."received_at") and (("device_grant_ingest_receipts"."final_response" is null and "device_grant_ingest_receipts"."finalized_at" is null) or (jsonb_typeof("device_grant_ingest_receipts"."final_response")='object' and "device_grant_ingest_receipts"."finalized_at" is not null and isfinite("device_grant_ingest_receipts"."finalized_at"))))
);
--> statement-breakpoint
ALTER TABLE "device_grant_consumption" ADD CONSTRAINT "device_grant_consumption_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_consumption" ADD CONSTRAINT "device_grant_consumption_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_consumption" ADD CONSTRAINT "device_grant_consumption_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_effects" ADD CONSTRAINT "device_grant_effects_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_effects" ADD CONSTRAINT "device_grant_effects_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_effects" ADD CONSTRAINT "device_grant_effects_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_effects" ADD CONSTRAINT "device_grant_effects_receipt_fk" FOREIGN KEY ("tenant_id","receipt_id") REFERENCES "public"."device_grant_ingest_receipts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_effects" ADD CONSTRAINT "device_grant_effects_grant_fk" FOREIGN KEY ("tenant_id","grant_id") REFERENCES "public"."device_grant_issuances"("tenant_id","grant_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_ingest_receipts" ADD CONSTRAINT "device_grant_ingest_receipts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_ingest_receipts" ADD CONSTRAINT "device_grant_ingest_receipts_configuration_id_device_grant_configurations_id_fk" FOREIGN KEY ("configuration_id") REFERENCES "public"."device_grant_configurations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_ingest_receipts" ADD CONSTRAINT "device_grant_ingest_station_fk" FOREIGN KEY ("tenant_id","station_device_id","owner_kind") REFERENCES "public"."station_devices"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_grant_ingest_receipts" ADD CONSTRAINT "device_grant_ingest_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_grant_config_station_latest_idx" ON "device_grant_configurations" USING btree ("tenant_id","owner_kind","station_device_id","sequence") WHERE "device_grant_configurations"."station_device_id" is not null;--> statement-breakpoint
CREATE INDEX "device_grant_config_kiosk_latest_idx" ON "device_grant_configurations" USING btree ("tenant_id","owner_kind","kiosk_id","sequence") WHERE "device_grant_configurations"."kiosk_id" is not null;--> statement-breakpoint
CREATE TRIGGER device_grant_effects_immutable BEFORE UPDATE OR DELETE ON device_grant_effects FOR EACH ROW EXECUTE FUNCTION device_grant_history_immutable();
--> statement-breakpoint
CREATE FUNCTION device_grant_ingest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE configuration device_grant_configurations%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Grant receipts are retained' USING ERRCODE='23514'; END IF;
  IF TG_OP = 'UPDATE' AND (OLD.final_response IS NOT NULL OR (to_jsonb(NEW)-'final_response'-'finalized_at') IS DISTINCT FROM (to_jsonb(OLD)-'final_response'-'finalized_at')) THEN
    RAISE EXCEPTION 'Grant receipt identity and final classification are immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.configuration_id IS NOT NULL THEN
    SELECT * INTO configuration FROM device_grant_configurations WHERE id=NEW.configuration_id;
    IF FOUND AND (configuration.tenant_id IS DISTINCT FROM NEW.tenant_id OR configuration.owner_kind IS DISTINCT FROM NEW.owner_kind OR configuration.station_device_id IS DISTINCT FROM NEW.station_device_id OR configuration.kiosk_id IS DISTINCT FROM NEW.kiosk_id OR configuration.mode IS DISTINCT FROM NEW.mode) THEN
      RAISE EXCEPTION 'Grant receipt configuration owner mismatch' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.mode='strict' THEN RAISE EXCEPTION 'Strict receipt requires server configuration' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER device_grant_ingest_guard BEFORE INSERT OR UPDATE OR DELETE ON device_grant_ingest_receipts FOR EACH ROW EXECUTE FUNCTION device_grant_ingest_guard();
--> statement-breakpoint
CREATE FUNCTION device_grant_effect_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE receipt device_grant_ingest_receipts%ROWTYPE; issuance device_grant_issuances%ROWTYPE;
BEGIN
 SELECT * INTO receipt FROM device_grant_ingest_receipts WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id;
 IF FOUND AND (receipt.owner_kind IS DISTINCT FROM NEW.owner_kind OR receipt.station_device_id IS DISTINCT FROM NEW.station_device_id OR receipt.kiosk_id IS DISTINCT FROM NEW.kiosk_id) THEN RAISE EXCEPTION 'Grant effect receipt owner mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO issuance FROM device_grant_issuances WHERE tenant_id=NEW.tenant_id AND grant_id=NEW.grant_id;
 IF FOUND AND (issuance.owner_kind IS DISTINCT FROM NEW.owner_kind OR issuance.station_device_id IS DISTINCT FROM NEW.station_device_id OR issuance.kiosk_id IS DISTINCT FROM NEW.kiosk_id OR issuance.credential_epoch IS DISTINCT FROM NEW.credential_epoch) THEN RAISE EXCEPTION 'Grant effect issuance owner mismatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER device_grant_effect_owner_guard BEFORE INSERT ON device_grant_effects FOR EACH ROW EXECUTE FUNCTION device_grant_effect_owner_guard();
