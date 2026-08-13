ALTER TABLE "sscc_counters" ALTER COLUMN "next_serial" SET DEFAULT 1;--> statement-breakpoint

UPDATE "sscc_counters" AS c
SET "next_serial" = 1, "updated_at" = now()
WHERE c."extension_digit" = 0
  AND c."next_serial" = 0
  AND NOT EXISTS (
    SELECT 1
    FROM "sscc_blocks" AS b
    WHERE b."tenant_id" = c."tenant_id"
      AND b."issuer_prefix" = c."issuer_prefix"
      AND b."extension_digit" = c."extension_digit"
  );
