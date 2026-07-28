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
  // Device-generated and deterministic: "<machineId>:<highest outbox id>".
  // Stable across a retry AND across an app restart, which is what makes the
  // server's idempotency key actually protect a resend.
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
