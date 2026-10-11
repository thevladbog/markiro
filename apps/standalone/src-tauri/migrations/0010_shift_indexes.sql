-- Plan ХП: indexes by shift for the retention's deletes (stage 2a, decision
-- 31; plan 2a8). The pass deletes a purged shift's rows by `host_id`,
-- `device_id` and `shift_id`; without these `outbox`, `floor_exceptions` and
-- `floor_pallet_exceptions` were read whole inside the write transaction
-- (176 ms against 37 ms at 600 000 outbox rows). The shift leads each index
-- on purpose: led by `(host_id, device_id)` an index becomes the first step of
-- the hourly due select (`DUE_SHIFTS_SQL`, a walk of every record of the
-- pairing instead of `outbox_settled`), and with `acked_at` after the shift
-- also of the status bar's count of unsent records. `acked_at` ends the
-- outbox's index, so the retention's check for an unsent record of a shift
-- reads the index alone. Additive: no row changes, no foreign key (see
-- `0006`).
CREATE INDEX outbox_shift ON outbox (shift_id, host_id, device_id, acked_at);

CREATE INDEX floor_exceptions_shift ON floor_exceptions (shift_id, host_id, device_id);

CREATE INDEX floor_pallet_exceptions_shift ON floor_pallet_exceptions (shift_id, host_id, device_id);
