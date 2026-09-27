-- Rename the sole civil business date; PostgreSQL rebinds CHECK expressions.
-- No row, frozen JSON, or timestamp is rewritten.
ALTER TABLE "traceability_events" RENAME COLUMN "date_received" TO "event_date";
--> statement-breakpoint
-- PL/pgSQL record references are textual, unlike CHECK expressions. Preserve
-- the installed version-pinned v1/v2 and v3 guards in full, changing only their
-- physical date reference. Fail closed if the expected definitions have drifted.
DO $rebind$
DECLARE guard_name text; definition text;
BEGIN
  FOREACH guard_name IN ARRAY ARRAY[
    'receiving_header_finalization_guard()',
    'receiving_header_finalization_v3_guard()'
  ] LOOP
    SELECT pg_get_functiondef(guard_name::regprocedure) INTO definition;
    IF (length(definition) - length(replace(definition, 'NEW.date_received', '')))
       <> length('NEW.date_received') THEN
      RAISE EXCEPTION 'Unexpected Receiving date guard definition: %', guard_name;
    END IF;
    EXECUTE replace(definition, 'NEW.date_received', 'NEW.event_date');
  END LOOP;
END
$rebind$;
