CREATE TABLE "codes" (
  "tenant_id" text NOT NULL REFERENCES "organization"("id"),
  "code_hash" char(64) NOT NULL,
  "shift_id" uuid NOT NULL,
  "gtin14" char(14) NOT NULL,
  "serial" text NOT NULL,
  "scanned_at" timestamptz NOT NULL,
  PRIMARY KEY ("tenant_id", "code_hash", "scanned_at")
) PARTITION BY RANGE ("scanned_at");

CREATE TABLE "scan_events" (
  "tenant_id" text NOT NULL REFERENCES "organization"("id"),
  "shift_id" uuid NOT NULL,
  "terminal_id" text,
  "raw" text NOT NULL,
  "verdict" text NOT NULL,
  "scanned_at" timestamptz NOT NULL
) PARTITION BY RANGE ("scanned_at");

CREATE INDEX "codes_shift_idx" ON "codes" ("shift_id");
CREATE INDEX "scan_events_shift_idx" ON "scan_events" ("shift_id", "scanned_at");
