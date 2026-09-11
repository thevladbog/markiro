CREATE TABLE "pallet_exceptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kind" text NOT NULL,
	"pallet_id" uuid NOT NULL,
	"shift_id" uuid NOT NULL,
	"terminal_id" text,
	"operator_id" uuid,
	"reason" text NOT NULL,
	"disaggregation_document_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pallet_exceptions_kind_check" CHECK ("pallet_exceptions"."kind" IN ('disassemble', 'reprint'))
);
--> statement-breakpoint
CREATE TABLE "pallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"shift_id" uuid NOT NULL,
	"terminal_id" text,
	"device_pallet_id" text NOT NULL,
	"sscc" char(18),
	"operator_id" uuid,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	"closure_received_at" timestamp with time zone,
	"print_verified_at" timestamp with time zone,
	"print_skipped_at" timestamp with time zone,
	"disassembled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pallets_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pallets_tenant_sscc_uq" UNIQUE("tenant_id","sscc"),
	CONSTRAINT "pallets_device_pallet_uq" UNIQUE NULLS NOT DISTINCT("tenant_id","shift_id","terminal_id","device_pallet_id")
);
--> statement-breakpoint
CREATE TABLE "org_pallet_label_template_defaults" (
	"tenant_id" text NOT NULL,
	"chz_product_group_code" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_pallet_label_template_defaults_tenant_id_chz_product_group_code_pk" PRIMARY KEY("tenant_id","chz_product_group_code")
);
--> statement-breakpoint
ALTER TABLE "label_templates" DROP CONSTRAINT "label_templates_purpose_check";--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "pallet_id" uuid;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "pallet_box_capacity" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "pallet_box_capacity" integer;--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "pallet_label_template_id" uuid;--> statement-breakpoint
ALTER TABLE "org_profiles" ADD COLUMN "default_pallet_label_template_id" uuid;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD COLUMN "pallet_id" uuid;--> statement-breakpoint
ALTER TABLE "pallet_exceptions" ADD CONSTRAINT "pallet_exceptions_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_exceptions" ADD CONSTRAINT "pallet_exceptions_tenant_pallet_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_exceptions" ADD CONSTRAINT "pallet_exceptions_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallet_exceptions" ADD CONSTRAINT "pallet_exceptions_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_tenant_shift_fk" FOREIGN KEY ("tenant_id","shift_id") REFERENCES "public"."shifts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pallets" ADD CONSTRAINT "pallets_tenant_operator_fk" FOREIGN KEY ("tenant_id","operator_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_pallet_label_template_defaults" ADD CONSTRAINT "org_pallet_label_template_defaults_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_pallet_label_template_defaults" ADD CONSTRAINT "org_pallet_label_template_defaults_chz_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("chz_product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_pallet_label_template_defaults" ADD CONSTRAINT "org_pallet_label_template_defaults_template_tenant_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pallet_exceptions_tenant_pallet_idx" ON "pallet_exceptions" USING btree ("tenant_id","pallet_id","recorded_at");--> statement-breakpoint
CREATE INDEX "pallet_exceptions_tenant_shift_recorded_idx" ON "pallet_exceptions" USING btree ("tenant_id","shift_id","recorded_at");--> statement-breakpoint
CREATE INDEX "pallets_tenant_shift_idx" ON "pallets" USING btree ("tenant_id","shift_id");--> statement-breakpoint
ALTER TABLE "boxes" ADD CONSTRAINT "boxes_tenant_pallet_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_tenant_pallet_label_template_fk" FOREIGN KEY ("tenant_id","pallet_label_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profiles" ADD CONSTRAINT "org_profiles_pallet_label_template_tenant_fk" FOREIGN KEY ("tenant_id","default_pallet_label_template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_tenant_pallet_fk" FOREIGN KEY ("tenant_id","pallet_id") REFERENCES "public"."pallets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boxes_tenant_pallet_idx" ON "boxes" USING btree ("tenant_id","pallet_id");--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_purpose_check" CHECK ("label_templates"."purpose" IN ('box', 'product_duplicate', 'pallet'));--> statement-breakpoint
ALTER TABLE "disaggregation_document_lines" ADD CONSTRAINT "disaggregation_document_lines_target_check" CHECK (num_nonnulls("disaggregation_document_lines"."box_id", "disaggregation_document_lines"."pallet_id") <= 1);--> statement-breakpoint
-- Hand-added below this line; drizzle-kit generated everything above.
--
-- Hand-spelled because `disaggregation.ts` imports FROM `platform.ts`, so
-- expressing this in the Drizzle definition would be an import cycle. The
-- same precedent `box_exceptions_tenant_disaggregation_document_fk` sets in
-- migration 0046. `drizzle-kit generate` will not propose dropping it: it
-- diffs schema snapshots, not the live database, so a constraint that only
-- ever existed in raw SQL never shows up as a pending change.
ALTER TABLE "pallet_exceptions" ADD CONSTRAINT "pallet_exceptions_tenant_disaggregation_document_fk" FOREIGN KEY ("tenant_id","disaggregation_document_id") REFERENCES "public"."disaggregation_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- PALLET CAPACITY CHANGES MEANING, not just its column name: it used to hold
-- product UNITS and now holds a BOX COUNT. A pallet fills with boxes, and a
-- box closed short would otherwise make "full" land at an unpredictable box
-- count.
--
-- Values that can be converted are converted. Values that cannot become NULL,
-- because a units figure left under a "boxes" name is a WRONG value rather
-- than a preserved one, and NULL truthfully says "unknown, enter it again".
-- Nothing printed or reported has ever read this column — pallets have never
-- functioned — so there is nothing else to preserve.
--
-- The old column is not dropped here: migration 0131 drops it, so an operator
-- who needs to read the old numbers back still can between the two.
UPDATE "products"
   SET "pallet_box_capacity" = floor("pallet_capacity"::numeric / "box_capacity")::integer
 WHERE "pallet_capacity" IS NOT NULL
   AND "box_capacity" IS NOT NULL
   AND "box_capacity" > 0
   AND floor("pallet_capacity"::numeric / "box_capacity") >= 1;
--> statement-breakpoint
UPDATE "shifts"
   SET "pallet_box_capacity" = floor("pallet_capacity"::numeric / "box_capacity")::integer
 WHERE "pallet_capacity" IS NOT NULL
   AND "box_capacity" IS NOT NULL
   AND "box_capacity" > 0
   AND floor("pallet_capacity"::numeric / "box_capacity") >= 1;
--> statement-breakpoint
-- Seed the stock pallet label for tenants that already exist. New tenants get
-- it from tenant-provisioning.service.ts; these rows are the same template, so
-- an operator on either path sees one stock pallet label and not two.
-- The name is the (tenant_id, name) seed identity, exactly as the box
-- families are, so a re-run cannot duplicate it.
INSERT INTO label_templates (id, tenant_id, name, purpose, spec)
SELECT gen_random_uuid(), o.id, 'Паллета 100×150', 'pallet', '{"widthMm":100,"heightMm":150,"dpi":203,"language":"zpl","elements":[{"kind":"text","id":"cap-title","xMm":5,"yMm":5,"text":"ПАЛЛЕТА","fontSizePt":12,"bold":true,"maxWidthMm":90},{"kind":"field","id":"val-name","xMm":5,"yMm":13,"field":"product.name","fontSizePt":14,"bold":true,"maxWidthMm":90,"maxLines":3},{"kind":"line","id":"sep1","xMm":5,"yMm":36,"x2Mm":95,"y2Mm":36,"thicknessMm":0.4},{"kind":"text","id":"cap-boxes","xMm":5,"yMm":39,"text":"Коробов:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-boxes","xMm":5,"yMm":45,"field":"qty.boxes","fontSizePt":14,"bold":true,"maxWidthMm":42},{"kind":"text","id":"cap-units","xMm":53,"yMm":39,"text":"Единиц:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-units","xMm":53,"yMm":45,"field":"qty","fontSizePt":14,"bold":true,"maxWidthMm":42},{"kind":"text","id":"cap-date","xMm":5,"yMm":58,"text":"Дата производства:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-date","xMm":5,"yMm":64,"field":"date","fontSizePt":11,"bold":true,"maxWidthMm":42},{"kind":"text","id":"cap-expiry","xMm":53,"yMm":58,"text":"Годен до:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-expiry","xMm":53,"yMm":64,"field":"expiry","fontSizePt":11,"bold":true,"maxWidthMm":42},{"kind":"text","id":"cap-shift","xMm":5,"yMm":75,"text":"Смена:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-shift","xMm":5,"yMm":81,"field":"shift.no","fontSizePt":11,"bold":true,"maxWidthMm":42},{"kind":"text","id":"cap-gtin","xMm":53,"yMm":75,"text":"GTIN:","fontSizePt":8,"maxWidthMm":42},{"kind":"field","id":"val-gtin","xMm":53,"yMm":81,"field":"product.gtin","fontSizePt":11,"bold":true,"maxWidthMm":42},{"kind":"line","id":"sep2","xMm":5,"yMm":93,"x2Mm":95,"y2Mm":93,"thicknessMm":0.4},{"kind":"barcode","id":"bc-sscc","xMm":11,"yMm":99,"format":"code128","data":"sscc","sizeMm":30,"moduleWidthMm":0.5005},{"kind":"field","id":"val-sscc","xMm":5,"yMm":132,"field":"sscc","fontSizePt":12,"align":"center","maxWidthMm":90}]}'::jsonb
  FROM organization o
 WHERE NOT EXISTS (
   SELECT 1 FROM label_templates t
    WHERE t.tenant_id = o.id AND t.name = 'Паллета 100×150'
 );
--> statement-breakpoint
-- Point every existing profile at it, leaving a profile that somehow has none
-- alone rather than inventing one.
UPDATE org_profiles p
   SET default_pallet_label_template_id = t.id
  FROM label_templates t
 WHERE t.tenant_id = p.tenant_id
   AND t.name = 'Паллета 100×150'
   AND t.purpose = 'pallet'
   AND p.default_pallet_label_template_id IS NULL;
