ALTER TABLE "traceability_lots" ADD COLUMN "last_source_reason" text;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD COLUMN "source_locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "traceability_lots" ADD CONSTRAINT "traceability_lots_source_reason_length" CHECK (length(btrim("traceability_lots"."last_source_reason")) BETWEEN 3 AND 2000);
--> statement-breakpoint
-- Finalization must set source_locked_at while holding the lot row lock in the
-- same transaction as frozen event snapshots. This latch is never cleared by
-- amendment/void. First latching cannot also replace identity: corrections must
-- use the revisioned/audited command before finalization. The trigger is
-- hand-maintained; Drizzle snapshots omit it.
CREATE FUNCTION "traceability_lots_guard_source_locked"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.source_locked_at IS NOT NULL AND
      NEW.source_locked_at IS DISTINCT FROM OLD.source_locked_at) OR (
    (OLD.source_locked_at IS NOT NULL OR NEW.source_locked_at IS NOT NULL) AND
    ROW(NEW.id, NEW.tenant_id, NEW.product_id, NEW.tlc, NEW.assignment_basis,
        NEW.source_location_id, NEW.source_reference_kind, NEW.source_reference_value,
        NEW.source_reference_location_id)
      IS DISTINCT FROM
    ROW(OLD.id, OLD.tenant_id, OLD.product_id, OLD.tlc, OLD.assignment_basis,
        OLD.source_location_id, OLD.source_reference_kind, OLD.source_reference_value,
        OLD.source_reference_location_id)
  ) THEN
    RAISE EXCEPTION 'lot_source_locked'
      USING ERRCODE = '23514', CONSTRAINT = 'traceability_lots_source_locked';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "traceability_lots_source_locked"
BEFORE UPDATE ON "traceability_lots"
FOR EACH ROW EXECUTE FUNCTION "traceability_lots_guard_source_locked"();
