CREATE TABLE "organization_logo_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"object_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"checksum" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"status" "media_asset_status" DEFAULT 'staging' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_logo_assets_object_key_uq" UNIQUE("object_key"),
	CONSTRAINT "organization_logo_assets_tenant_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "org_profiles" ADD COLUMN "logo_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_logo_assets" ADD CONSTRAINT "organization_logo_assets_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_profiles" ADD CONSTRAINT "org_profiles_logo_tenant_fk" FOREIGN KEY ("tenant_id","logo_asset_id") REFERENCES "public"."organization_logo_assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;