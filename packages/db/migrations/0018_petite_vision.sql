CREATE TABLE "box_items" (
	"tenant_id" text NOT NULL,
	"box_id" uuid NOT NULL,
	"code_hash" char(64) NOT NULL,
	"added_at" timestamp with time zone NOT NULL,
	"displaced_at" timestamp with time zone,
	CONSTRAINT "box_items_tenant_id_box_id_code_hash_pk" PRIMARY KEY("tenant_id","box_id","code_hash")
);
--> statement-breakpoint
CREATE TABLE "boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"terminal_id" text,
	"device_box_id" text NOT NULL,
	"sscc" char(18),
	"operator_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"print_verified_at" timestamp with time zone,
	"print_skipped_at" timestamp with time zone,
	CONSTRAINT "boxes_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "boxes_tenant_sscc_uq" UNIQUE("tenant_id","sscc"),
	CONSTRAINT "boxes_device_box_uq" UNIQUE("tenant_id","shift_id","terminal_id","device_box_id")
);
--> statement-breakpoint
CREATE TABLE "sscc_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"issuer_prefix" char(9) NOT NULL,
	"extension_digit" integer NOT NULL,
	"device_id" uuid NOT NULL,
	"from_serial" bigint NOT NULL,
	"to_serial" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sscc_counters" (
	"tenant_id" text NOT NULL,
	"issuer_prefix" char(9) NOT NULL,
	"extension_digit" integer NOT NULL,
	"next_serial" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sscc_counters_tenant_id_issuer_prefix_extension_digit_pk" PRIMARY KEY("tenant_id","issuer_prefix","extension_digit")
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "sscc_issuer_counterparty_id" uuid;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "box_label_template_id" uuid;--> statement-breakpoint
ALTER TABLE "box_items" ADD CONSTRAINT "box_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "box_items" ADD CONSTRAINT "box_items_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sscc_blocks" ADD CONSTRAINT "sscc_blocks_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sscc_blocks" ADD CONSTRAINT "sscc_blocks_tenant_device_fk" FOREIGN KEY ("tenant_id","device_id") REFERENCES "public"."station_devices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sscc_counters" ADD CONSTRAINT "sscc_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "box_items_tenant_code_idx" ON "box_items" USING btree ("tenant_id","code_hash");--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_sscc_issuer_fk" FOREIGN KEY ("tenant_id","sscc_issuer_counterparty_id") REFERENCES "public"."counterparties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_box_label_template_fk" FOREIGN KEY ("tenant_id","box_label_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- scan_events is hand-migrated (partitioned; excluded from drizzle-kit's
-- schema list — see src/schema/codes.ts). Its DDL is appended here by hand.
ALTER TABLE "scan_events" ADD COLUMN "operator_id" uuid;--> statement-breakpoint
ALTER TABLE "scan_events" ADD CONSTRAINT "scan_events_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;