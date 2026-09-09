ALTER TABLE "national_catalog_import_operation_items" ADD COLUMN "applied_evidence" jsonb;--> statement-breakpoint
-- Canonical accepted intent and committed product evidence survive independent photo retries.
-- Nullable evidence preserves pre-migration receipts without invented provenance.
CREATE FUNCTION nc_import_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.decision IS DISTINCT FROM OLD.decision
     OR (OLD.applied_evidence IS NOT NULL AND NEW.applied_evidence IS DISTINCT FROM OLD.applied_evidence) THEN
    RAISE EXCEPTION 'National Catalog accepted intent and applied evidence are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER nc_import_receipt_immutable_update BEFORE UPDATE ON national_catalog_import_operation_items
FOR EACH ROW EXECUTE FUNCTION nc_import_receipt_immutable();
