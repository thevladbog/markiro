CREATE TYPE "public"."tlc_assignment_basis" AS ENUM('transformation', 'initial_packing', 'first_land_receiving', 'exempt_supplier_receipt', 'imported');--> statement-breakpoint
CREATE TYPE "public"."traceability_lot_status" AS ENUM('active', 'consumed', 'shipped', 'quarantined', 'recalled', 'archived');--> statement-breakpoint
CREATE TABLE "traceability_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"tlc" text NOT NULL,
	"assignment_basis" "tlc_assignment_basis" NOT NULL,
	"source_location_id" uuid,
	"source_reference_kind" text,
	"source_reference_value" text,
	"source_reference_location_id" uuid,
	"status" "traceability_lot_status" DEFAULT 'active' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"last_status_reason" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_lots_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_lots_tlc_valid" CHECK (length("traceability_lots"."tlc") BETWEEN 1 AND 120 AND "traceability_lots"."tlc" = btrim("traceability_lots"."tlc") AND "traceability_lots"."tlc" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "traceability_lots_revision_positive" CHECK ("traceability_lots"."revision" > 0),
	CONSTRAINT "traceability_lots_source_shape" CHECK (("traceability_lots"."source_reference_kind" IS NULL AND "traceability_lots"."source_reference_value" IS NULL AND "traceability_lots"."source_reference_location_id" IS NULL) OR ("traceability_lots"."source_location_id" IS NULL AND "traceability_lots"."source_reference_kind" IS NOT NULL AND "traceability_lots"."source_reference_kind" = 'web_url' AND "traceability_lots"."source_reference_value" IS NOT NULL AND "traceability_lots"."source_reference_location_id" IS NOT NULL)),
	CONSTRAINT "traceability_lots_reference_length" CHECK (octet_length("traceability_lots"."source_reference_value") BETWEEN 1 AND 1024),
	CONSTRAINT "traceability_lots_actor_shape" CHECK (length(btrim("traceability_lots"."created_by")) BETWEEN 1 AND 128 AND length(btrim("traceability_lots"."updated_by")) BETWEEN 1 AND 128),
	CONSTRAINT "traceability_lots_reason_length" CHECK (length(btrim("traceability_lots"."last_status_reason")) BETWEEN 3 AND 2000)
);
--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_source_location_fk" FOREIGN KEY ("tenant_id","source_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_reference_location_fk" FOREIGN KEY ("tenant_id","source_reference_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_lots_location_tlc_uq" ON "traceability_lots" USING btree ("tenant_id","source_location_id","tlc") WHERE "traceability_lots"."source_location_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_lots_reference_tlc_uq" ON "traceability_lots" USING btree ("tenant_id","source_reference_kind","source_reference_value","tlc") WHERE "traceability_lots"."source_reference_kind" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_lots_missing_source_tlc_uq" ON "traceability_lots" USING btree ("tenant_id","tlc") WHERE "traceability_lots"."source_location_id" IS NULL AND "traceability_lots"."source_reference_kind" IS NULL;--> statement-breakpoint
CREATE INDEX "traceability_lots_tenant_product_idx" ON "traceability_lots" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "traceability_lots_tenant_status_idx" ON "traceability_lots" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "traceability_lots_tenant_tlc_idx" ON "traceability_lots" USING btree ("tenant_id","tlc");