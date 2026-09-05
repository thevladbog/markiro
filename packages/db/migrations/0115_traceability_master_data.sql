CREATE TYPE "public"."traceability_address_kind" AS ENUM('street', 'coordinates');--> statement-breakpoint
CREATE TYPE "public"."traceability_location_role" AS ENUM('supplier', 'processor', 'ship_from', 'receive_at', 'recipient', 'tlc_source');--> statement-breakpoint
CREATE TABLE "traceability_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"party_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_name" text NOT NULL,
	"phone_number" text,
	"address_kind" "traceability_address_kind" DEFAULT 'street' NOT NULL,
	"street_address" text,
	"latitude" numeric(9, 6),
	"longitude" numeric(9, 6),
	"city" text,
	"state_or_region" text,
	"zip_or_postal_code" text,
	"country_code" text,
	"roles" "traceability_location_role"[] DEFAULT '{}' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_locations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_locations_name_nonempty" CHECK (length(btrim("traceability_locations"."name")) > 0),
	CONSTRAINT "traceability_locations_business_name_nonempty" CHECK (length(btrim("traceability_locations"."business_name")) > 0),
	CONSTRAINT "traceability_locations_country_code_format" CHECK ("traceability_locations"."country_code" IS NULL OR "traceability_locations"."country_code" ~ '^[A-Z]{2}$'),
	CONSTRAINT "traceability_locations_latitude_range" CHECK ("traceability_locations"."latitude" IS NULL OR "traceability_locations"."latitude" BETWEEN -90 AND 90),
	CONSTRAINT "traceability_locations_longitude_range" CHECK ("traceability_locations"."longitude" IS NULL OR "traceability_locations"."longitude" BETWEEN -180 AND 180),
	CONSTRAINT "traceability_locations_address_shape" CHECK (("traceability_locations"."address_kind" = 'street' AND "traceability_locations"."latitude" IS NULL AND "traceability_locations"."longitude" IS NULL) OR ("traceability_locations"."address_kind" = 'coordinates' AND "traceability_locations"."street_address" IS NULL)),
	CONSTRAINT "traceability_locations_roles_shape" CHECK (cardinality("traceability_locations"."roles") <= 6 AND array_position("traceability_locations"."roles", NULL) IS NULL)
);
--> statement-breakpoint
CREATE TABLE "traceability_parties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"contact_name" text,
	"contact_phone" text,
	"contact_email" text,
	"notes" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "traceability_parties_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "traceability_parties_name_nonempty" CHECK (length(btrim("traceability_parties"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "traceability_locations" ADD CONSTRAINT "traceability_locations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_locations" ADD CONSTRAINT "traceability_locations_tenant_party_fk" FOREIGN KEY ("tenant_id","party_id") REFERENCES "public"."traceability_parties"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "traceability_parties" ADD CONSTRAINT "traceability_parties_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "traceability_locations_tenant_party_idx" ON "traceability_locations" USING btree ("tenant_id","party_id");--> statement-breakpoint
CREATE INDEX "traceability_locations_roles_idx" ON "traceability_locations" USING gin ("roles");--> statement-breakpoint
CREATE UNIQUE INDEX "traceability_parties_active_name_uq" ON "traceability_parties" USING btree ("tenant_id",lower("name")) WHERE "traceability_parties"."archived" = false;