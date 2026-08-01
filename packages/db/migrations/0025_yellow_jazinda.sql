-- The station previously sent the plaintext kmKey into char(64) code_hash
-- columns. The product has not entered production, so reset only operational
-- scan/aggregation facts rather than inventing crypto tails or preserving
-- internally inconsistent test data.
TRUNCATE TABLE "box_exceptions", "box_items", "boxes", "code_conflicts", "code_registry", "codes", "scan_events", "sync_batches";--> statement-breakpoint
ALTER TABLE "codes" ADD COLUMN "canonical_raw" text NOT NULL;--> statement-breakpoint
ALTER TABLE "codes" ADD CONSTRAINT "codes_hash_check" CHECK ("codes"."code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "codes" ADD CONSTRAINT "codes_canonical_raw_size_check" CHECK (octet_length("codes"."canonical_raw") BETWEEN 1 AND 1024);--> statement-breakpoint
ALTER TABLE "box_exceptions" ADD CONSTRAINT "box_exceptions_hash_check" CHECK ("box_exceptions"."code_hash" IS NULL OR "box_exceptions"."code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "box_items" ADD CONSTRAINT "box_items_hash_check" CHECK ("box_items"."code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "code_conflicts" ADD CONSTRAINT "code_conflicts_hash_check" CHECK ("code_conflicts"."code_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "code_registry" ADD CONSTRAINT "code_registry_hash_check" CHECK ("code_registry"."code_hash" ~ '^[0-9a-f]{64}$');
