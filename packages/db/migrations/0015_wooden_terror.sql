CREATE TABLE "sync_batches" (
	"tenant_id" text NOT NULL,
	"batch_id" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_batches_tenant_id_batch_id_pk" PRIMARY KEY("tenant_id","batch_id")
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "late_data_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_batches" ADD CONSTRAINT "sync_batches_tenant_id_organization_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."organization"("id") ON DELETE no action ON UPDATE no action;