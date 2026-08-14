CREATE TABLE "product_images" (
	"tenant_id" text NOT NULL,
	"product_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_images_tenant_id_product_id_pk" PRIMARY KEY("tenant_id","product_id"),
	CONSTRAINT "product_images_asset_id_uq" UNIQUE("asset_id")
);
--> statement-breakpoint
ALTER TABLE "media_assets" ADD COLUMN "owner_tenant_id" text;--> statement-breakpoint
ALTER TABLE "media_assets" ALTER COLUMN "owner_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_tenant_id_organization_id_fk" FOREIGN KEY ("owner_tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_tenant_id_uq" UNIQUE("owner_tenant_id","id");--> statement-breakpoint
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_xor" CHECK (num_nonnulls("media_assets"."owner_user_id", "media_assets"."owner_tenant_id") = 1);--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_product_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_images" ADD CONSTRAINT "product_images_tenant_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."media_assets"("owner_tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
