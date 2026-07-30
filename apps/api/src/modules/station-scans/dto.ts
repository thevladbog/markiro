import { z } from "zod";
import { MAX_BOX_CLOSURES_PER_SYNC_BATCH } from "@markiro/domain";

const scanItemSchema = z.object({
  // Normalised to lowercase here, at the boundary: Postgres's `uuid` type is
  // case-insensitive on input but always renders lowercase on output, so a
  // client-sent uppercase id would otherwise match the tenant-scoped shift
  // guard (semantic uuid comparison in SQL) yet fail a same-value JS string
  // comparison against a value read back from the database (e.g. `sameScan`
  // in conflict-resolution.ts, comparing a fresh claim's shiftId against a
  // registry row's). Normalising once here keeps every downstream string
  // comparison correct without each of them having to know about this.
  shiftId: z.string().uuid().toLowerCase(),
  terminalId: z.string().nullable(),
  raw: z.string().min(1),
  verdict: z.string().min(1),
  scannedAt: z.string().datetime(),
  code: z
    .object({
      codeHash: z.string().length(64),
      gtin14: z.string().length(14),
      serial: z.string().min(1),
    })
    .nullable(),
  // A null boxId is an ordinary scan not assigned to any box (06c's boxing
  // is per-item, not a batch-wide setting).
  boxId: z.string().min(1).max(64).nullable(),
  // Per scan, not per batch: a drained batch can span a handover, and a
  // per-batch attribution would credit one operator with another's work.
  operatorId: z.string().uuid().toLowerCase().nullable(),
});

export const syncBatchSchema = z.object({
  // Device-generated: "<machineId>:<per-installation id>:<highest outbox id
  // in the batch>" (see apps/station/src/lib/sync.ts and install-id.ts).
  // Stable across a retry of that same batch -- including one triggered by a
  // later nudge while the previous attempt is still outstanding -- which is
  // what makes this key actually protect a resend: the device pins the row
  // range it resends rather than re-reading a fresh (potentially larger)
  // prefix. The per-installation component changes only when the device's
  // local database is recreated, so a device that lost just its local
  // database (but kept its enrollment) cannot collide with a key already
  // recorded for the database it replaced.
  batchId: z.string().min(1).max(200),
  // Bounded so a buggy or hostile device cannot submit an unbounded payload;
  // the station's own batch size is 200.
  items: z.array(scanItemSchema).max(500),
  // Box closures carried by this batch. Independent of `items`: a box can
  // close well after its last item was drained, in a batch carrying no
  // items at all -- the drain is sequential, so the box row it refers to
  // (created by an earlier item's arrival, see boxes' schema comment)
  // already exists by the time its closure gets here.
  boxes: z
    .array(
      z.object({
        boxId: z.string().min(1).max(64),
        // `boxes_device_box_uq` scopes a device's box id to (shift,
        // terminal): a bare deviceBoxId string is NOT unique on its own --
        // two terminals in one tenant can both call a box "b1", and one
        // device can reuse a box id after a shift change. Carrying these
        // (Finding 3 on this task) is what lets the closure UPDATE identify
        // exactly one box instead of matching every row sharing that string;
        // the device already knows both, the same way it does for a scan
        // item above.
        shiftId: z.string().uuid().toLowerCase(),
        terminalId: z.string().nullable(),
        sscc: z.string().length(18),
        closedAt: z.string().datetime(),
        operatorId: z.string().uuid().toLowerCase().nullable(),
        // Whether the closed box's printed label was verified or explicitly
        // skipped, as recorded on the device's own `boxes_mirror` row (Task
        // 13 review, Finding 6). `.default(null)`, not `.optional()`: an
        // older station build mid-rollout that has not yet learned to send
        // these two fields must still be accepted -- their absence means
        // exactly the same thing an explicit null does, "not yet resolved".
        printVerifiedAt: z.string().datetime().nullable().default(null),
        printSkippedAt: z.string().datetime().nullable().default(null),
      }),
    )
    // Shared with the station's own drain loop (`MAX_BOX_CLOSURES_PER_SYNC_
    // BATCH` in `apps/station/src/lib/sync.ts`, sourced from
    // `@markiro/domain`): the two sides MUST agree, or a device that reads
    // more closed-unacked boxes than this endpoint accepts would have its
    // whole batch rejected here every time, wedging both box closures and
    // item delivery on that device forever (the drain retries a rejected
    // batch indefinitely rather than ever dropping data).
    .max(MAX_BOX_CLOSURES_PER_SYNC_BATCH)
    .default([]),
  // Operator exceptions carried by this batch (undo/clear/disassemble/
  // reprint) -- see box-exceptions.ts. Independent of `items`/`boxes` for
  // the same reason boxes are: the fact a device queues can outlive the
  // scan or closure it corrects by an arbitrary number of batches.
  exceptions: z
    .array(
      z.object({
        kind: z.enum(["undo", "clear", "disassemble", "reprint"]),
        boxId: z.string().min(1).max(64),
        codeHash: z.string().length(64).nullable(),
        shiftId: z.string().uuid().toLowerCase(),
        terminalId: z.string().nullable(),
        operatorId: z.string().uuid().toLowerCase().nullable(),
        reason: z.string().min(1).nullable(),
        occurredAt: z.string().datetime(),
      }),
    )
    .max(200)
    .default([]),
});

export type ScanItemDto = z.infer<typeof scanItemSchema>;
export type SyncBatchDto = z.infer<typeof syncBatchSchema>;

/** A code in THIS batch that lost ownership to an earlier scan elsewhere. */
export interface BatchConflictDto {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

export interface SyncBatchResponseDto {
  applied: number;
  alreadyApplied: boolean;
  /**
   * Only this batch's OWN losses. A scan of ours that displaced someone
   * else's is not here — that station's batch was acknowledged long ago and
   * the cabinet is its backstop.
   */
  conflicts: BatchConflictDto[];
}
