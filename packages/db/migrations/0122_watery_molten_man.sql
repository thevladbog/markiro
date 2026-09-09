CREATE TABLE "national_catalog_import_dispatch_attempts" (
	"kind" text NOT NULL,
	"tenant_id" text NOT NULL,
	"work_id" uuid NOT NULL,
	"step_id" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "national_catalog_import_dispatch_attempts_kind_tenant_id_work_id_step_id_pk" PRIMARY KEY("kind","tenant_id","work_id","step_id"),
	CONSTRAINT "nc_import_dispatch_kind_ck" CHECK ("national_catalog_import_dispatch_attempts"."kind" in ('enumerate','prepare','candidate','apply','accepted_image','refresh'))
);
--> statement-breakpoint
ALTER TABLE "national_catalog_import_dispatch_attempts" ADD CONSTRAINT "national_catalog_import_dispatch_attempts_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "nc_import_dispatch_tenant_attempt_idx" ON "national_catalog_import_dispatch_attempts" USING btree ("tenant_id","attempted_at");