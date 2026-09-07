CREATE TABLE "receiving_counters" (
	"tenant_id" text NOT NULL,
	"year" integer NOT NULL,
	"sequence" integer NOT NULL,
	CONSTRAINT "receiving_counters_tenant_id_year_pk" PRIMARY KEY("tenant_id","year"),
	CONSTRAINT "receiving_counters_valid" CHECK ("receiving_counters"."year" BETWEEN 1 AND 9999 AND "receiving_counters"."sequence" > 0)
);
--> statement-breakpoint
CREATE TABLE "receiving_event_documents" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "receiving_event_documents_tenant_id_event_id_document_id_pk" PRIMARY KEY("tenant_id","event_id","document_id"),
	CONSTRAINT "receiving_documents_position_uq" UNIQUE("tenant_id","event_id","position"),
	CONSTRAINT "receiving_documents_position_valid" CHECK ("receiving_event_documents"."position" BETWEEN 1 AND 100)
);
--> statement-breakpoint
CREATE TABLE "receiving_event_items" (
	"tenant_id" text NOT NULL,
	"event_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"product_id" uuid,
	"lot_id" uuid,
	"lot_link_mode" text NOT NULL,
	"tlc" text,
	"quantity" text,
	"unit_of_measure" text,
	"source_location_id" uuid,
	"source_reference_kind" text,
	"source_reference_value" text,
	"source_reference_location_id" uuid,
	"exempt_supplier" boolean NOT NULL,
	"exempt_reason" text,
	"supplier_lot_reference" text,
	"notes" text,
	CONSTRAINT "receiving_event_items_tenant_id_event_id_line_no_pk" PRIMARY KEY("tenant_id","event_id","line_no"),
	CONSTRAINT "receiving_items_position_valid" CHECK ("receiving_event_items"."line_no" BETWEEN 1 AND 100),
	CONSTRAINT "receiving_items_mode_valid" CHECK ("receiving_event_items"."lot_link_mode" IN ('create_on_finalize', 'link_existing')),
	CONSTRAINT "receiving_items_quantity_valid" CHECK ("receiving_event_items"."quantity" ~ '^(0|[1-9][0-9]{0,14})([.][0-9]{1,3})?$' AND "receiving_event_items"."quantity" ~ '[1-9]'),
	CONSTRAINT "receiving_items_tlc_valid" CHECK (length("receiving_event_items"."tlc") BETWEEN 1 AND 120 AND "receiving_event_items"."tlc" = btrim("receiving_event_items"."tlc") AND "receiving_event_items"."tlc" !~ U&'[\0001-\001F\007F-\009F]'),
	CONSTRAINT "receiving_items_text_valid" CHECK (length(btrim("receiving_event_items"."exempt_reason")) BETWEEN 1 AND 2000 AND length(btrim("receiving_event_items"."supplier_lot_reference")) BETWEEN 1 AND 128 AND length(btrim("receiving_event_items"."notes")) BETWEEN 1 AND 2000),
	CONSTRAINT "receiving_items_source_shape" CHECK ((
    "receiving_event_items"."source_location_id" IS NULL AND "receiving_event_items"."source_reference_kind" IS NULL AND "receiving_event_items"."source_reference_value" IS NULL AND "receiving_event_items"."source_reference_location_id" IS NULL
  ) OR (
    "receiving_event_items"."source_location_id" IS NOT NULL AND "receiving_event_items"."source_reference_kind" IS NULL AND "receiving_event_items"."source_reference_value" IS NULL AND "receiving_event_items"."source_reference_location_id" IS NULL
  ) OR (
    "receiving_event_items"."source_location_id" IS NULL AND "receiving_event_items"."source_reference_kind" IS NOT NULL AND "receiving_event_items"."source_reference_kind" = 'web_url'
    AND "receiving_event_items"."source_reference_value" IS NOT NULL AND octet_length("receiving_event_items"."source_reference_value") BETWEEN 1 AND 1024
    AND "receiving_event_items"."source_reference_location_id" IS NOT NULL
  ))
);
--> statement-breakpoint
CREATE TABLE "receiving_operations" (
	"tenant_id" text NOT NULL,
	"command" text NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"event_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receiving_operations_tenant_id_command_operation_key_pk" PRIMARY KEY("tenant_id","command","operation_key"),
	CONSTRAINT "receiving_operations_command_valid" CHECK ("receiving_operations"."command" IN ('receiving.create', 'receiving.save')),
	CONSTRAINT "receiving_operations_digest_valid" CHECK ("receiving_operations"."input_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "receiving_operations_result_valid" CHECK (jsonb_typeof("receiving_operations"."result") = 'object')
);
--> statement-breakpoint
CREATE TABLE "traceability_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"event_number" text NOT NULL,
	"type" text DEFAULT 'receiving' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"draft_version" integer DEFAULT 1 NOT NULL,
	"time_zone" text NOT NULL,
	"date_received" date,
	"location_id" uuid,
	"previous_source_location_id" uuid,
	"received_at_note" text,
	"notes" text,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_events_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_events_number_uq" UNIQUE("tenant_id","event_number"),
	CONSTRAINT "traceability_events_draft_only" CHECK ("traceability_events"."type" = 'receiving' AND "traceability_events"."status" = 'draft' AND "traceability_events"."revision" = 1),
	CONSTRAINT "traceability_events_version_valid" CHECK ("traceability_events"."draft_version" > 0),
	CONSTRAINT "traceability_events_number_valid" CHECK ("traceability_events"."event_number" ~ '^REC-[0-9]{2}-[0-9]{4,10}$'),
	CONSTRAINT "traceability_events_zone_valid" CHECK (length("traceability_events"."time_zone") BETWEEN 1 AND 64),
	CONSTRAINT "traceability_events_date_valid" CHECK ("traceability_events"."date_received" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'),
	CONSTRAINT "traceability_events_notes_valid" CHECK (length(btrim("traceability_events"."notes")) BETWEEN 1 AND 2000 AND length(btrim("traceability_events"."received_at_note")) BETWEEN 1 AND 2000),
	CONSTRAINT "traceability_events_actors_valid" CHECK (length(btrim("traceability_events"."created_by")) BETWEEN 1 AND 128 AND length(btrim("traceability_events"."updated_by")) BETWEEN 1 AND 128)
);
--> statement-breakpoint
ALTER TABLE "receiving_counters" ADD CONSTRAINT "receiving_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_documents" ADD CONSTRAINT "receiving_event_documents_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_documents" ADD CONSTRAINT "receiving_documents_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."traceability_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_documents" ADD CONSTRAINT "receiving_documents_document_fk" FOREIGN KEY ("tenant_id","document_id") REFERENCES "public"."reference_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_event_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."traceability_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_source_fk" FOREIGN KEY ("tenant_id","source_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_event_items" ADD CONSTRAINT "receiving_items_reference_source_fk" FOREIGN KEY ("tenant_id","source_reference_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receiving_operations" ADD CONSTRAINT "receiving_operations_event_fk" FOREIGN KEY ("tenant_id","event_id") REFERENCES "public"."traceability_events"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_location_fk" FOREIGN KEY ("tenant_id","location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_events" ADD CONSTRAINT "traceability_events_previous_source_fk" FOREIGN KEY ("tenant_id","previous_source_location_id") REFERENCES "public"."traceability_locations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "traceability_events_tenant_created_idx" ON "traceability_events" USING btree ("tenant_id","created_at","id");
