CREATE TABLE "trace_lot_box_operations" (
	"tenant_id" text NOT NULL,
	"command" text NOT NULL,
	"operation_key" uuid NOT NULL,
	"input_digest" text NOT NULL,
	"target_id" uuid NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trace_lot_box_operations_tenant_id_command_operation_key_pk" PRIMARY KEY("tenant_id","command","operation_key"),
	CONSTRAINT "trace_lot_box_operations_command_valid" CHECK ("trace_lot_box_operations"."command" IN ('case.link','case.unlink')),
	CONSTRAINT "trace_lot_box_operations_digest_valid" CHECK ("trace_lot_box_operations"."input_digest" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "trace_lot_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"box_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"sscc_at_link" text NOT NULL,
	"link_source" text NOT NULL,
	"linked_by" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unlinked_at" timestamp with time zone,
	"unlinked_by" text,
	"unlink_reason" text,
	CONSTRAINT "trace_lot_boxes_sscc_shape" CHECK ("trace_lot_boxes"."sscc_at_link" ~ '^[0-9]{18}$'),
	CONSTRAINT "trace_lot_boxes_link_source_valid" CHECK ("trace_lot_boxes"."link_source" IN ('manual','demo_seed')),
	CONSTRAINT "trace_lot_boxes_unlink_all_or_none" CHECK (("trace_lot_boxes"."unlinked_at" IS NULL AND "trace_lot_boxes"."unlinked_by" IS NULL AND "trace_lot_boxes"."unlink_reason" IS NULL) OR ("trace_lot_boxes"."unlinked_at" IS NOT NULL AND "trace_lot_boxes"."unlinked_by" IS NOT NULL AND "trace_lot_boxes"."unlink_reason" IS NOT NULL AND length(btrim("trace_lot_boxes"."unlink_reason")) BETWEEN 3 AND 2000))
);
--> statement-breakpoint
CREATE TABLE "traceability_synthetic_case_origins" (
	"tenant_id" text NOT NULL,
	"box_id" uuid NOT NULL,
	"seed_id" text NOT NULL,
	"seed_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_synthetic_case_origins_tenant_id_box_id_pk" PRIMARY KEY("tenant_id","box_id"),
	CONSTRAINT "synthetic_case_origins_seed_valid" CHECK (length(btrim("traceability_synthetic_case_origins"."seed_id")) > 0 AND "traceability_synthetic_case_origins"."seed_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "trace_lot_box_operations" ADD CONSTRAINT "trace_lot_box_operations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_lot_boxes" ADD CONSTRAINT "trace_lot_boxes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_lot_boxes" ADD CONSTRAINT "trace_lot_boxes_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_lot_boxes" ADD CONSTRAINT "trace_lot_boxes_lot_fk" FOREIGN KEY ("tenant_id","lot_id") REFERENCES "public"."traceability_lots"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_synthetic_case_origins" ADD CONSTRAINT "traceability_synthetic_case_origins_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_synthetic_case_origins" ADD CONSTRAINT "synthetic_case_origins_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trace_lot_boxes_one_active_box_uq" ON "trace_lot_boxes" USING btree ("tenant_id","box_id") WHERE "trace_lot_boxes"."unlinked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "trace_lot_boxes_lot_active_idx" ON "trace_lot_boxes" USING btree ("tenant_id","lot_id","linked_at","id") WHERE "trace_lot_boxes"."unlinked_at" IS NULL;
--> statement-breakpoint
CREATE FUNCTION trace_lot_boxes_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'case link history is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.unlinked_at IS NULL
     AND NEW.unlinked_at IS NOT NULL
     AND NEW.unlinked_by IS NOT NULL
     AND NEW.unlink_reason IS NOT NULL
     AND (to_jsonb(NEW) - 'unlinked_at' - 'unlinked_by' - 'unlink_reason') =
         (to_jsonb(OLD) - 'unlinked_at' - 'unlinked_by' - 'unlink_reason') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'case link history is immutable' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER trace_lot_boxes_guard_trigger BEFORE UPDATE OR DELETE ON trace_lot_boxes
FOR EACH ROW EXECUTE FUNCTION trace_lot_boxes_guard();
--> statement-breakpoint
CREATE FUNCTION trace_case_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'case provenance and receipts are immutable' USING ERRCODE = '23514';
END $$;
--> statement-breakpoint
CREATE TRIGGER traceability_synthetic_case_origins_guard_trigger
BEFORE UPDATE OR DELETE ON traceability_synthetic_case_origins
FOR EACH ROW EXECUTE FUNCTION trace_case_append_only_guard();
--> statement-breakpoint
CREATE TRIGGER trace_lot_box_operations_guard_trigger
BEFORE UPDATE OR DELETE ON trace_lot_box_operations
FOR EACH ROW EXECUTE FUNCTION trace_case_append_only_guard();
