ALTER TABLE "inventory_document_runs" ADD COLUMN "organization_name_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "organization_inn_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "inventory_number_snapshot" text;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ADD COLUMN "inventory_closed_at_snapshot" timestamp with time zone;--> statement-breakpoint
UPDATE "inventory_document_runs" AS "run"
SET
  "organization_name_snapshot" = "organization"."name",
  "organization_inn_snapshot" = "profile"."inn",
  "inventory_number_snapshot" = "inventory"."number",
  "inventory_closed_at_snapshot" = coalesce("inventory"."closed_at", "run"."created_at")
FROM "inventories" AS "inventory"
INNER JOIN "organization" ON "organization"."id" = "inventory"."tenant_id"
LEFT JOIN "org_profiles" AS "profile" ON "profile"."tenant_id" = "inventory"."tenant_id"
WHERE
  "run"."tenant_id" = "inventory"."tenant_id"
  AND "run"."inventory_id" = "inventory"."id";--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "organization_name_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "inventory_number_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "inventory_document_runs" ALTER COLUMN "inventory_closed_at_snapshot" SET NOT NULL;
