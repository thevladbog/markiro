CREATE TABLE "public_api_key_identities" (
	"key_id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "public_api_key_identity_tenant_key_uq" UNIQUE("tenant_id","key_id")
);
--> statement-breakpoint
CREATE TABLE "public_api_request_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"key_id" text NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_digest" text NOT NULL,
	"effect_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"admission" jsonb,
	"staged_object_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "public_api_request_identity_uq" UNIQUE("tenant_id","key_id","operation","idempotency_key"),
	CONSTRAINT "public_api_request_digest_check" CHECK ("public_api_request_receipts"."payload_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "public_api_request_key_check" CHECK (length("public_api_request_receipts"."idempotency_key") between 1 and 200),
	CONSTRAINT "public_api_request_state_check" CHECK (("public_api_request_receipts"."state" = 'pending' and "public_api_request_receipts"."response" is null and "public_api_request_receipts"."completed_at" is null) or ("public_api_request_receipts"."state" = 'completed' and "public_api_request_receipts"."response" is not null and "public_api_request_receipts"."completed_at" is not null and "public_api_request_receipts"."admission" is not null))
);
--> statement-breakpoint
ALTER TABLE "inventories" DROP CONSTRAINT "inventories_started_fields_check";--> statement-breakpoint
ALTER TABLE "inventories" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_imports" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ALTER COLUMN "fixed_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "inventories" ADD COLUMN "created_by_public_key_id" text;--> statement-breakpoint
ALTER TABLE "inventories" ADD COLUMN "started_by_public_key_id" text;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD COLUMN "created_by_public_key_id" text;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD COLUMN "fixed_by_public_key_id" text;--> statement-breakpoint
ALTER TABLE "public_api_key_identities" ADD CONSTRAINT "public_api_key_identities_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "public_api_request_receipts" ADD CONSTRAINT "public_api_request_tenant_key_fk" FOREIGN KEY ("tenant_id","key_id") REFERENCES "public"."public_api_key_identities"("tenant_id","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_started_public_key_fk" FOREIGN KEY ("tenant_id","started_by_public_key_id") REFERENCES "public"."public_api_key_identities"("tenant_id","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_created_public_key_fk" FOREIGN KEY ("tenant_id","created_by_public_key_id") REFERENCES "public"."public_api_key_identities"("tenant_id","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_created_public_key_fk" FOREIGN KEY ("tenant_id","created_by_public_key_id") REFERENCES "public"."public_api_key_identities"("tenant_id","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_fixed_public_key_fk" FOREIGN KEY ("tenant_id","fixed_by_public_key_id") REFERENCES "public"."public_api_key_identities"("tenant_id","key_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_created_actor_check" CHECK (num_nonnulls("inventories"."created_by_user_id", "inventories"."created_by_public_key_id") = 1);--> statement-breakpoint
ALTER TABLE "inventories" ADD CONSTRAINT "inventories_started_fields_check" CHECK ((num_nonnulls("inventories"."started_by_user_id","inventories"."started_by_public_key_id") = 0 and "inventories"."started_at" is null)
          or (num_nonnulls("inventories"."started_by_user_id","inventories"."started_by_public_key_id") = 1 and "inventories"."started_at" is not null));--> statement-breakpoint
ALTER TABLE "inventory_imports" ADD CONSTRAINT "inventory_imports_created_actor_check" CHECK (num_nonnulls("inventory_imports"."created_by_user_id", "inventory_imports"."created_by_public_key_id") = 1);--> statement-breakpoint
ALTER TABLE "inventory_snapshots" ADD CONSTRAINT "inventory_snapshots_fixed_actor_check" CHECK (num_nonnulls("inventory_snapshots"."fixed_by_user_id", "inventory_snapshots"."fixed_by_public_key_id") = 1);--> statement-breakpoint
-- Preserve only real tenant-owned public key identities; metadata grants no authority here.
INSERT INTO public_api_key_identities (key_id, tenant_id, created_at)
SELECT a.id, a.reference_id, a.created_at FROM apikey a
JOIN organization o ON o.id = a.reference_id WHERE a.config_id = 'public'
ON CONFLICT (key_id) DO NOTHING;
--> statement-breakpoint
CREATE FUNCTION preserve_public_api_key_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.config_id = 'public' AND EXISTS (SELECT 1 FROM organization WHERE id=NEW.reference_id) THEN
    INSERT INTO public_api_key_identities(key_id,tenant_id,created_at)
      VALUES(NEW.id,NEW.reference_id,NEW.created_at) ON CONFLICT (key_id) DO NOTHING;
    IF EXISTS(SELECT 1 FROM public_api_key_identities WHERE key_id=NEW.id AND tenant_id<>NEW.reference_id) THEN
      RAISE EXCEPTION 'Public key historical tenant cannot change' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER preserve_public_api_key_identity AFTER INSERT OR UPDATE OF reference_id, config_id
ON apikey FOR EACH ROW EXECUTE FUNCTION preserve_public_api_key_identity();
