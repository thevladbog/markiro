CREATE TYPE "public"."employee_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."kiosk_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."pickup_order_status" AS ENUM('pending', 'punched', 'writtenoff', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."pickup_reason" AS ENUM('buy', 'writeoff');--> statement-breakpoint
CREATE TABLE "employee_badges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"employee_id" uuid NOT NULL,
	"badge_code" text NOT NULL,
	"label" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"full_name" text NOT NULL,
	"role" text,
	"status" "employee_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "employees_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "kiosk_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"kiosk_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosk_products_uq" UNIQUE("tenant_id","kiosk_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "kiosks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"device_token_hash" text,
	"day_limit_per_employee" integer DEFAULT 5 NOT NULL,
	"show_prices" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone,
	"status" "kiosk_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kiosks_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "pickup_order_counters" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"seq" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pickup_order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"order_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"gtin14" text NOT NULL,
	"serial" text NOT NULL,
	"raw_km" text NOT NULL,
	"km_key" text NOT NULL,
	"unit_price" numeric(12, 2),
	"voided" boolean DEFAULT false NOT NULL,
	"scanned_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pickup_order_items_order_kmkey_uq" UNIQUE("tenant_id","order_id","km_key")
);
--> statement-breakpoint
CREATE TABLE "pickup_order_reasons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pickup_order_reasons_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "pickup_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"order_no" text NOT NULL,
	"kiosk_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"reason" "pickup_reason" NOT NULL,
	"writeoff_reason_id" uuid,
	"status" "pickup_order_status" DEFAULT 'pending' NOT NULL,
	"item_count" integer NOT NULL,
	"total_price" numeric(12, 2),
	"receipt_no" text,
	"act_no" text,
	"device_seq" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	CONSTRAINT "pickup_orders_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pickup_orders_tenant_order_no_uq" UNIQUE("tenant_id","order_no"),
	CONSTRAINT "pickup_orders_kiosk_device_seq_uq" UNIQUE("tenant_id","kiosk_id","device_seq")
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "unit_price" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "egais_code" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "employee_badges" ADD CONSTRAINT "employee_badges_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_badges" ADD CONSTRAINT "employee_badges_tenant_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_products" ADD CONSTRAINT "kiosk_products_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_products" ADD CONSTRAINT "kiosk_products_tenant_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosk_products" ADD CONSTRAINT "kiosk_products_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kiosks" ADD CONSTRAINT "kiosks_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_counters" ADD CONSTRAINT "pickup_order_counters_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_items" ADD CONSTRAINT "pickup_order_items_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_items" ADD CONSTRAINT "pickup_order_items_tenant_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."pickup_orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_items" ADD CONSTRAINT "pickup_order_items_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_order_reasons" ADD CONSTRAINT "pickup_order_reasons_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_kiosk_fk" FOREIGN KEY ("tenant_id","kiosk_id") REFERENCES "public"."kiosks"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_employee_fk" FOREIGN KEY ("tenant_id","employee_id") REFERENCES "public"."employees"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pickup_orders" ADD CONSTRAINT "pickup_orders_tenant_reason_fk" FOREIGN KEY ("tenant_id","writeoff_reason_id") REFERENCES "public"."pickup_order_reasons"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employee_badges_tenant_code_active_uq" ON "employee_badges" USING btree ("tenant_id","badge_code") WHERE revoked_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "kiosks_device_token_uq" ON "kiosks" USING btree ("device_token_hash") WHERE device_token_hash is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "pickup_order_items_tenant_kmkey_open_uq" ON "pickup_order_items" USING btree ("tenant_id","km_key") WHERE voided = false;