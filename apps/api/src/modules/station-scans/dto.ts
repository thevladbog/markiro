import { z } from "zod";

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
        sscc: z.string().length(18),
        closedAt: z.string().datetime(),
        operatorId: z.string().uuid().toLowerCase().nullable(),
      }),
    )
    .max(50)
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
