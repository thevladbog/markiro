CREATE TABLE "box_registry_versions" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"current_version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_order_boxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"box_id" uuid NOT NULL,
	"sscc" char(18) NOT NULL,
	"product_id" uuid NOT NULL,
	"bottle_count" integer NOT NULL,
	"unit_price" numeric(12, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_order_boxes_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_order_boxes_tenant_order_id_uq" UNIQUE("tenant_id","order_id","id"),
	CONSTRAINT "pickup_order_boxes_order_box_uq" UNIQUE("tenant_id","order_id","box_id"),
	CONSTRAINT "pickup_order_boxes_bottle_count_check" CHECK ("pickup_order_boxes"."bottle_count" > 0)
);
--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "registry_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "boxes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pickup_order_items" ADD COLUMN "order_box_id" uuid;--> statement-breakpoint
ALTER TABLE "box_registry_versions" ADD CONSTRAINT "box_registry_versions_tenant_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
INSERT INTO "box_registry_versions" ("tenant_id", "current_version") SELECT "id", 0 FROM "organization" ON CONFLICT ("tenant_id") DO NOTHING;--> statement-breakpoint
ALTER TABLE "pickup_order_boxes" ADD CONSTRAINT "pickup_order_boxes_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_boxes" ADD CONSTRAINT "pickup_order_boxes_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pickup_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_boxes" ADD CONSTRAINT "pickup_order_boxes_tenant_box_fk" FOREIGN KEY ("tenant_id","box_id") REFERENCES "public"."boxes"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_boxes" ADD CONSTRAINT "pickup_order_boxes_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_items" ADD CONSTRAINT "pickup_order_items_tenant_order_box_fk" FOREIGN KEY ("tenant_id","order_id","order_box_id") REFERENCES "public"."pickup_order_boxes"("tenant_id","order_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "boxes_registry_cursor_idx" ON "boxes" USING btree ("tenant_id","registry_version","id");
