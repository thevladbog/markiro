ALTER TABLE "inventory_corrections" ADD COLUMN "request_digest" char(64);--> statement-breakpoint
UPDATE "inventory_corrections"
SET "request_digest" = "before_projection_digest"
WHERE "request_digest" IS NULL;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ALTER COLUMN "request_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_request_digest_check" CHECK ("inventory_corrections"."request_digest" ~ '^[0-9a-f]{64}$');
