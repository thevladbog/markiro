BEGIN;
ALTER TABLE "catalog_item_versions"
  VALIDATE CONSTRAINT "catalog_item_versions_kind_billing_check";
COMMIT;
