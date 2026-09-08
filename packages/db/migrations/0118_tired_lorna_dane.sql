CREATE TABLE "national_catalog_import_preparations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" uuid NOT NULL,
	"actor_id" text NOT NULL,
	"request_id" uuid NOT NULL,
	"request_hash" char(64) NOT NULL,
	"request" jsonb NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nc_import_preparations_tenant_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "nc_import_preparations_session_id_uq" UNIQUE("tenant_id","session_id","id"),
	CONSTRAINT "nc_import_preparations_request_uq" UNIQUE("tenant_id","session_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "national_catalog_import_preparations" ADD CONSTRAINT "national_catalog_import_preparations_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_preparations" ADD CONSTRAINT "national_catalog_import_preparations_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "national_catalog_import_preparations" ADD CONSTRAINT "nc_import_preparations_session_fk" FOREIGN KEY ("tenant_id","session_id") REFERENCES "public"."national_catalog_import_sessions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nc_import_preparations_repair_idx" ON "national_catalog_import_preparations" USING btree ("expires_at","updated_at");