ALTER TABLE "boxes" ADD COLUMN "disassembly_received_at" timestamp with time zone;--> statement-breakpoint
-- Hand-added below this line; drizzle-kit generated the ALTER above.
--
-- BACKFILL. `boxes.disassembled_at` is the operator's own device clock (the
-- station writes the `disassemble` exception's device-supplied `occurred_at`);
-- `pallets.closure_received_at` is a server `now()`. The pallet list's
-- `contents_changed_after_close` ordered one against the other, so a station
-- whose clock ran behind made a box that genuinely came off a closed, labelled
-- pallet compare as having come off before it -- and the flag that is the only
-- warning a manager gets that a pallet left the factory a box short silently
-- stayed false. `disassembly_received_at` is the server instant that ordering
-- needs, so every ALREADY-DISASSEMBLED box needs one too, or the flag would
-- read `false` for the whole history rather than merely wrong for part of it.
--
-- The server instant is RECOVERABLE, not guessed: every writer of
-- `disassembled_at` inserts a `box_exceptions` row with kind='disassemble' in
-- the SAME transaction, and that row's `recorded_at` defaults to `now()`.
-- Postgres `now()` is `transaction_timestamp()`, so it is the identical value
-- the disassembly statement itself would have written. `min()` picks the first
-- such exception, which is the one that actually set `disassembled_at`: the
-- station's UPDATE is guarded by `disassembled_at IS NULL`, so a redelivered
-- or duplicate `disassemble` writes another audit row but never re-stamps the
-- box. This also restores `removed_at = disassembly_received_at` -- the
-- predicate the box report uses to tell an item THIS disassembly released from
-- one another terminal's scan displaced -- for historical station-originated
-- disassemblies, where the two clocks never matched.
UPDATE "boxes" AS b
SET "disassembly_received_at" = e."recorded_at"
FROM (
  SELECT "tenant_id", "box_id", min("recorded_at") AS "recorded_at"
  FROM "box_exceptions"
  WHERE "kind" = 'disassemble'
  GROUP BY "tenant_id", "box_id"
) AS e
WHERE b."tenant_id" = e."tenant_id"
  AND b."id" = e."box_id"
  AND b."disassembled_at" IS NOT NULL;--> statement-breakpoint
-- A disassembled box with no `disassemble` audit row at all has no server
-- instant to recover. Copying its device timestamp across is the deliberate
-- choice: it preserves whatever answer the pallet list already gave for that
-- box instead of silently downgrading it to "nothing changed after close", and
-- a wrong-but-unchanged flag is strictly safer than a fresh false negative.
-- No production writer can produce such a row (both disassembly paths insert
-- the audit row in the same transaction), so this only covers rows written
-- directly into `boxes` by fixtures or a by-hand repair.
UPDATE "boxes"
SET "disassembly_received_at" = "disassembled_at"
WHERE "disassembled_at" IS NOT NULL
  AND "disassembly_received_at" IS NULL;
