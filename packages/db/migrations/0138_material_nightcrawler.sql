CREATE TABLE "traceability_plan_cleanup_fences" (
	"object_key" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"actor_user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"sha256" text NOT NULL,
	"state" text DEFAULT 'fenced' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_plan_cleanup_state_valid" CHECK ("traceability_plan_cleanup_fences"."state" IN ('fenced', 'deleted')),
	CONSTRAINT "traceability_plan_cleanup_hash_valid" CHECK ("traceability_plan_cleanup_fences"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "traceability_plan_cleanup_scope_valid" CHECK ("traceability_plan_cleanup_fences"."object_key" LIKE 'us/plans/' || "traceability_plan_cleanup_fences"."tenant_id" || '/' || "traceability_plan_cleanup_fences"."version_id"::text || '/%.pdf')
);
--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" DROP CONSTRAINT "traceability_plan_supersession_shape";--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "retention_floor" date;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "hold_until" date;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "indefinite_hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD COLUMN "retention_indefinite_reason" text;--> statement-breakpoint
ALTER TABLE "traceability_plan_cleanup_fences" ADD CONSTRAINT "traceability_plan_cleanup_fences_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_retention_reason_valid" CHECK ("traceability_plan_versions"."retention_indefinite_reason" IS NULL OR ("traceability_plan_versions"."status" = 'superseded' AND "traceability_plan_versions"."retain_through" IS NULL AND "traceability_plan_versions"."retention_indefinite_reason" IN ('hold', 'date_range_exceeded')));--> statement-breakpoint
ALTER TABLE "traceability_plan_versions" ADD CONSTRAINT "traceability_plan_supersession_shape" CHECK (
      ("traceability_plan_versions"."status" IN ('draft','effective') AND "traceability_plan_versions"."superseded_by_id" IS NULL AND "traceability_plan_versions"."superseded_at" IS NULL AND "traceability_plan_versions"."retain_through" IS NULL)
      OR ("traceability_plan_versions"."status" = 'superseded' AND "traceability_plan_versions"."superseded_by_id" IS NOT NULL AND "traceability_plan_versions"."superseded_at" IS NOT NULL AND ("traceability_plan_versions"."retain_through" IS NOT NULL OR "traceability_plan_versions"."retention_indefinite_reason" IS NOT NULL))
    );
--> statement-breakpoint
-- Extend only lifecycle-derived retention output; frozen evidence and policy inputs
-- remain immutable. Historical effective/superseded rows retain their old shape.
CREATE OR REPLACE FUNCTION traceability_plan_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
      (to_jsonb(NEW) - ARRAY['status','superseded_by_id','superseded_at','retain_through','retention_indefinite_reason','updated_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['status','superseded_by_id','superseded_at','retain_through','retention_indefinite_reason','updated_at']) THEN
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
CREATE FUNCTION traceability_plan_cleanup_fences_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Plan cleanup fences are permanent' USING ERRCODE = '23514';
  END IF;
  IF OLD.state <> 'fenced' OR NEW.state <> 'deleted' OR
    (to_jsonb(NEW) - 'state') IS DISTINCT FROM (to_jsonb(OLD) - 'state') THEN
    RAISE EXCEPTION 'Plan cleanup fences cannot be reopened' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER traceability_plan_cleanup_fences_guard_trigger
BEFORE UPDATE OR DELETE ON traceability_plan_cleanup_fences
FOR EACH ROW EXECUTE FUNCTION traceability_plan_cleanup_fences_guard();
