CREATE TABLE "org_profiles" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"gln" text,
	"gs1_prefixes" text[] DEFAULT '{}' NOT NULL,
	"inn" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_profiles" ADD CONSTRAINT "org_profiles_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;