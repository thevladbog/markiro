CREATE TABLE "traceability_plan_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"sections" jsonb NOT NULL,
	"change_summary" text DEFAULT '' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"config_snapshot" jsonb,
	"config_digest" text,
	"pdf_object_key" text,
	"pdf_sha256" text,
	"pdf_byte_size" integer,
	"renderer_version" text,
	"superseded_by_id" uuid,
	"superseded_at" timestamp with time zone,
	"retain_through" date,
	CONSTRAINT "traceability_plan_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_plan_tenant_version_uq" UNIQUE("tenant_id","version_number"),
	CONSTRAINT "traceability_plan_status_valid" CHECK ("traceability_plan_versions"."status" IN ('draft','effective','superseded')),
	CONSTRAINT "traceability_plan_versions_positive" CHECK ("traceability_plan_versions"."version_number" > 0 AND "traceability_plan_versions"."draft_revision" > 0 AND "traceability_plan_versions"."schema_version" > 0),
	CONSTRAINT "traceability_plan_sections_object" CHECK (jsonb_typeof("traceability_plan_versions"."sections") = 'object'),
	CONSTRAINT "traceability_plan_snapshot_object" CHECK (jsonb_typeof("traceability_plan_versions"."config_snapshot") = 'object'),
	CONSTRAINT "traceability_plan_actor_valid" CHECK ("traceability_plan_versions"."created_by" ~ '[^[:space:]]' AND "traceability_plan_versions"."approved_by" ~ '[^[:space:]]'),
	CONSTRAINT "traceability_plan_artifact_valid" CHECK ("traceability_plan_versions"."config_digest" ~ '^[a-fA-F0-9]{64}$' AND "traceability_plan_versions"."pdf_sha256" ~ '^[a-fA-F0-9]{64}$' AND "traceability_plan_versions"."pdf_byte_size" > 0 AND "traceability_plan_versions"."pdf_object_key" ~ '[^[:space:]]' AND "traceability_plan_versions"."renderer_version" ~ '[^[:space:]]'),
	CONSTRAINT "traceability_plan_change_summary_required" CHECK ("traceability_plan_versions"."status" = 'draft' OR "traceability_plan_versions"."version_number" = 1 OR "traceability_plan_versions"."change_summary" ~ '[^[:space:]]'),
	CONSTRAINT "traceability_plan_approval_shape" CHECK (
      ("traceability_plan_versions"."status" = 'draft' AND "traceability_plan_versions"."approved_by" IS NULL AND "traceability_plan_versions"."approved_at" IS NULL AND "traceability_plan_versions"."config_snapshot" IS NULL AND "traceability_plan_versions"."config_digest" IS NULL AND "traceability_plan_versions"."pdf_object_key" IS NULL AND "traceability_plan_versions"."pdf_sha256" IS NULL AND "traceability_plan_versions"."pdf_byte_size" IS NULL AND "traceability_plan_versions"."renderer_version" IS NULL)
      OR ("traceability_plan_versions"."status" IN ('effective','superseded') AND "traceability_plan_versions"."approved_by" IS NOT NULL AND "traceability_plan_versions"."approved_at" IS NOT NULL AND "traceability_plan_versions"."config_snapshot" IS NOT NULL AND "traceability_plan_versions"."config_digest" IS NOT NULL AND "traceability_plan_versions"."pdf_object_key" IS NOT NULL AND "traceability_plan_versions"."pdf_sha256" IS NOT NULL AND "traceability_plan_versions"."pdf_byte_size" IS NOT NULL AND "traceability_plan_versions"."renderer_version" IS NOT NULL)
    ),
	CONSTRAINT "traceability_plan_supersession_shape" CHECK (
      ("traceability_plan_versions"."status" IN ('draft','effective') AND "traceability_plan_versions"."superseded_by_id" IS NULL AND "traceability_plan_versions"."superseded_at" IS NULL AND "traceability_plan_versions"."retain_through" IS NULL)
      OR ("traceability_plan_versions"."status" = 'superseded' AND "traceability_plan_versions"."superseded_by_id" IS NOT NULL AND "traceability_plan_versions"."superseded_at" IS NOT NULL AND "traceability_plan_versions"."retain_through" IS NOT NULL)
    )
);
--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_versions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_superseded_by_fk" FOREIGN KEY ("tenant_id","superseded_by_id") REFERENCES "public"."traceability_plan_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_plan_one_draft_uq" ON "traceability_plan_versions" USING btree ("tenant_id") WHERE "traceability_plan_versions"."status" = 'draft';--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_plan_one_effective_uq" ON "traceability_plan_versions" USING btree ("tenant_id") WHERE "traceability_plan_versions"."status" = 'effective';
--> statement-breakpoint
-- Retain approved evidence independently of cabinet-account lifecycle. The only
-- approved update is effective -> superseded, preserving every frozen value.
CREATE FUNCTION traceability_plan_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Approved traceability plans cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.status = 'superseded' THEN
    RAISE EXCEPTION 'Superseded traceability plans are immutable' USING ERRCODE = '23514';
  ELSIF OLD.status = 'effective' THEN
    IF NEW.status IS DISTINCT FROM 'superseded' OR
      (to_jsonb(NEW) - ARRAY['status','superseded_by_id','superseded_at','retain_through','updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status','superseded_by_id','superseded_at','retain_through','updated_at']) THEN
      RAISE EXCEPTION 'Approved traceability plan evidence is immutable' USING ERRCODE = '23514';
    END IF;
  ELSIF ROW(NEW.id,NEW.tenant_id,NEW.version_number,NEW.created_by,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.tenant_id,OLD.version_number,OLD.created_by,OLD.created_at) THEN
    RAISE EXCEPTION 'Traceability plan draft identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER traceability_plan_versions_guard_trigger
BEFORE UPDATE OR DELETE ON traceability_plan_versions
FOR EACH ROW EXECUTE FUNCTION traceability_plan_versions_guard();
