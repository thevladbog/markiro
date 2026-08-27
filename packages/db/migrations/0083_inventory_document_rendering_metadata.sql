ALTER TABLE "inventory_document_runs" ADD COLUMN "organization_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "organization_inn_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "inventory_number_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "inventory_closed_at_snapshot" timestamp with time zone;--> statement-breakpoint
UPDATE "inventory_document_runs" AS "run"
SET
  "organization_name_snapshot" = "organization"."name",
  "organization_inn_snapshot" = "profile"."inn",
  "inventory_number_snapshot" = "inventory"."number",
  "inventory_closed_at_snapshot" = "inventory"."closed_at"
FROM "inventories" AS "inventory"
INNER JOIN "organization" ON "organization"."id" = "inventory"."tenant_id"
LEFT JOIN "org_profiles" AS "profile" ON "profile"."tenant_id" = "inventory"."tenant_id"
WHERE
  "run"."tenant_id" = "inventory"."tenant_id"
  AND "run"."inventory_id" = "inventory"."id";--> statement-breakpoint
WITH "closure_audits" AS (
  SELECT
    "run"."tenant_id",
    "run"."id" AS "run_id",
    "run"."result_revision",
    CASE
      WHEN "audit"."action" = 'inventory.reopened' THEN "audit"."before"
      ELSE "audit"."after"
    END AS "closure_fact",
    "audit"."created_at",
    "audit"."id" AS "audit_id"
  FROM "inventory_document_runs" AS "run"
  INNER JOIN "tenant_audit_events" AS "audit"
    ON "audit"."organization_id" = "run"."tenant_id"
    AND "audit"."target_type" = 'inventory'
    AND "audit"."target_id" = "run"."inventory_id"::text
    AND "audit"."outcome" = 'success'
    AND "audit"."action" IN ('inventory.closed', 'inventory.emergency_closed', 'inventory.reopened')
  WHERE "run"."inventory_closed_at_snapshot" IS NULL
),
"recovered_closures" AS (
  SELECT DISTINCT ON ("tenant_id", "run_id")
    "tenant_id",
    "run_id",
    ("closure_fact" ->> 'closedAt')::timestamp with time zone AS "closed_at"
  FROM "closure_audits"
  WHERE
    "closure_fact" ->> 'resultRevision' = "result_revision"::text
    AND "closure_fact" ->> 'closedAt' IS NOT NULL
  ORDER BY "tenant_id", "run_id", "created_at" DESC, "audit_id" DESC
)
UPDATE "inventory_document_runs" AS "run"
SET "inventory_closed_at_snapshot" = "recovered"."closed_at"
FROM "recovered_closures" AS "recovered"
WHERE
  "run"."tenant_id" = "recovered"."tenant_id"
  AND "run"."id" = "recovered"."run_id";--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "inventory_document_runs"
    WHERE "inventory_closed_at_snapshot" IS NULL
  ) THEN
    RAISE EXCEPTION 'inventory document run close timestamp could not be recovered from inventory or audit history'
      USING ERRCODE = '23502';
  END IF;
END
$$;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "organization_name_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "inventory_number_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "inventory_closed_at_snapshot" SET NOT NULL;
