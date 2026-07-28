CREATE TABLE "sync_batches" (
  "tenant_id" text NOT NULL REFERENCES "organization"("id"),
  "batch_id" text NOT NULL,
  "applied_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("tenant_id", "batch_id")
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD COLUMN "late_data_at" timestamptz;
