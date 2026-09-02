CREATE TABLE "org_box_label_template_defaults" (
	"tenant_id" text NOT NULL,
	"chz_product_group_code" integer NOT NULL,
	"template_id" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_box_label_template_defaults_tenant_id_chz_product_group_code_pk" PRIMARY KEY("tenant_id","chz_product_group_code")
);
--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "label_templates" ADD COLUMN "chz_product_group_codes" integer[];--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_chz_product_group_code_chz_product_groups_code_fk" FOREIGN KEY ("chz_product_group_code") REFERENCES "public"."chz_product_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_box_label_template_defaults" ADD CONSTRAINT "org_box_label_template_defaults_template_tenant_fk" FOREIGN KEY ("tenant_id","template_id") REFERENCES "public"."label_templates"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "label_templates" ADD CONSTRAINT "label_templates_product_group_codes_nonempty" CHECK ("label_templates"."chz_product_group_codes" IS NULL OR cardinality("label_templates"."chz_product_group_codes") > 0);