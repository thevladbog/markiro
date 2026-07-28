import { z } from "zod";

const scanItemSchema = z.object({
  shiftId: z.string().uuid(),
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
});

export type ScanItemDto = z.infer<typeof scanItemSchema>;
export type SyncBatchDto = z.infer<typeof syncBatchSchema>;

export interface SyncBatchResponseDto {
  applied: number;
  alreadyApplied: boolean;
}
