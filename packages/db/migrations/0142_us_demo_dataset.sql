CREATE TABLE "traceability_demo_dataset_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"dataset_id" uuid NOT NULL,
	"unit_key" text NOT NULL,
	"stage" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"input" jsonb NOT NULL,
	"receipt" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_demo_dataset_stages_stage_uq" UNIQUE("tenant_id","dataset_id","unit_key","stage"),
	CONSTRAINT "traceability_demo_dataset_stages_operation_uq" UNIQUE("tenant_id","dataset_id","operation_key"),
	CONSTRAINT "traceability_demo_dataset_stages_revision_valid" CHECK ("traceability_demo_dataset_stages"."revision" BETWEEN 1 AND 2),
	CONSTRAINT "traceability_demo_dataset_stages_completion_valid" CHECK (("traceability_demo_dataset_stages"."revision" = 1 AND "traceability_demo_dataset_stages"."receipt" IS NULL) OR ("traceability_demo_dataset_stages"."revision" = 2 AND "traceability_demo_dataset_stages"."receipt" IS NOT NULL)),
	CONSTRAINT "traceability_demo_dataset_stages_digest_valid" CHECK ("traceability_demo_dataset_stages"."input_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "traceability_demo_dataset_stages_unit_valid" CHECK ("traceability_demo_dataset_stages"."unit_key" ~ '^[a-z][a-z0-9_-]{0,63}$'),
	CONSTRAINT "traceability_demo_dataset_stages_stage_valid" CHECK ("traceability_demo_dataset_stages"."stage" IN ('references','receiving','amend_receiving','void_receiving','transformation','cases','shipping','trace_readiness','plan','request','package')),
	CONSTRAINT "traceability_demo_dataset_stages_input_valid" CHECK (jsonb_typeof("traceability_demo_dataset_stages"."input") = 'object' AND octet_length("traceability_demo_dataset_stages"."input"::text) <= 16777216),
	CONSTRAINT "traceability_demo_dataset_stages_receipt_valid" CHECK ("traceability_demo_dataset_stages"."receipt" IS NULL OR (jsonb_typeof("traceability_demo_dataset_stages"."receipt") = 'object' AND octet_length("traceability_demo_dataset_stages"."receipt"::text) <= 16777216))
);
--> statement-breakpoint
CREATE TABLE "traceability_demo_datasets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"version" text NOT NULL,
	"definition_digest" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_demo_datasets_scope_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_demo_datasets_tenant_uq" UNIQUE("tenant_id"),
	CONSTRAINT "traceability_demo_datasets_version_valid" CHECK ("traceability_demo_datasets"."version" = 'us-processor-six-month-v1'),
	CONSTRAINT "traceability_demo_datasets_digest_valid" CHECK ("traceability_demo_datasets"."definition_digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "traceability_demo_datasets_manifest_valid" CHECK (jsonb_typeof("traceability_demo_datasets"."manifest") = 'object' AND octet_length("traceability_demo_datasets"."manifest"::text) <= 16777216)
);
--> statement-breakpoint
ALTER TABLE "traceability_demo_dataset_stages" ADD CONSTRAINT "traceability_demo_dataset_stages_dataset_fk" FOREIGN KEY ("tenant_id","dataset_id") REFERENCES "public"."traceability_demo_datasets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_demo_datasets" ADD CONSTRAINT "traceability_demo_datasets_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Both journals serialize initialization with the compact store's existing lock.
-- VOLATILE PL/pgSQL reads after the lock use a fresh READ COMMITTED snapshot,
-- including a competing header that committed while this INSERT was waiting.
CREATE FUNCTION public.traceability_demo_header_insert_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id || ':' || 'us-processor-demo-v1', 0));
  IF TG_TABLE_NAME = 'traceability_demo_datasets' THEN
    IF EXISTS (SELECT 1 FROM public.traceability_demo_seeds WHERE tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'us_dataset_compact_conflict' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM public.traceability_demo_datasets WHERE tenant_id = NEW.tenant_id) THEN
      RAISE EXCEPTION 'us_demo_dataset_conflict' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER traceability_demo_datasets_insert_guard
BEFORE INSERT ON public.traceability_demo_datasets
FOR EACH ROW EXECUTE FUNCTION public.traceability_demo_header_insert_guard();
--> statement-breakpoint
CREATE TRIGGER traceability_demo_seeds_insert_guard
BEFORE INSERT ON public.traceability_demo_seeds
FOR EACH ROW EXECUTE FUNCTION public.traceability_demo_header_insert_guard();
