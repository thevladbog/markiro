ALTER TABLE "inventory_corrections" ADD COLUMN "request_digest" char(64);--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD COLUMN "effect_at" timestamp with time zone;--> statement-breakpoint
UPDATE "inventory_corrections"
SET "request_digest" = COALESCE("request_digest", "before_projection_digest"),
    "effect_at" = COALESCE("effect_at", "created_at")
WHERE "request_digest" IS NULL OR "effect_at" IS NULL;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ALTER COLUMN "request_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ALTER COLUMN "effect_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_corrections" ADD CONSTRAINT "inventory_corrections_request_digest_check" CHECK ("inventory_corrections"."request_digest" ~ '^[0-9a-f]{64}$');
