import { z } from "zod";
import {
  canonicalizeKm,
  kmHash,
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_KM_UTF8_BYTES,
} from "@markiro/domain";

const scanItemSchema = z
  .object({
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
    raw: z
      .string()
      .min(1)
      .max(MAX_KM_UTF8_BYTES)
      .refine((value) => !value.includes("\0"), "raw must not contain NUL")
      .refine(
        (value) => Buffer.byteLength(value, "utf8") <= MAX_KM_UTF8_BYTES,
        `raw must not exceed ${MAX_KM_UTF8_BYTES} UTF-8 bytes`,
      ),
    verdict: z.enum(["ok", "duplicate", "wrong_gtin", "invalid"]),
    scannedAt: z.string().datetime(),
    code: z
      .object({
        codeHash: z.string().regex(/^[0-9a-f]{64}$/),
        gtin14: z.string().regex(/^\d{14}$/),
        serial: z.string().min(1),
      })
      .nullable(),
    // A null boxId is an ordinary scan not assigned to any box (06c's boxing
    // is per-item, not a batch-wide setting).
    boxId: z.string().min(1).max(64).nullable(),
    // Per scan, not per batch: a drained batch can span a handover, and a
    // per-batch attribution would credit one operator with another's work.
    operatorId: z.string().uuid().toLowerCase().nullable(),
  })
  .superRefine((item, ctx) => {
    const accepted = item.verdict === "ok";
    if (accepted !== (item.code !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["code"],
        message: "code must be present if and only if verdict is ok",
      });
      return;
    }
    if (item.boxId !== null && item.code === null) {
      ctx.addIssue({
        code: "custom",
        path: ["boxId"],
        message: "boxId requires an accepted code",
      });
    }
    if (item.code === null) return;

    try {
      const km = canonicalizeKm(item.raw);
      if (kmHash(km) !== item.code.codeHash) {
        ctx.addIssue({ code: "custom", path: ["code", "codeHash"], message: "codeHash mismatch" });
      }
      if (km.gtin14 !== item.code.gtin14) {
        ctx.addIssue({ code: "custom", path: ["code", "gtin14"], message: "gtin14 mismatch" });
      }
      if (km.serial !== item.code.serial) {
        ctx.addIssue({ code: "custom", path: ["code", "serial"], message: "serial mismatch" });
      }
    } catch {
      ctx.addIssue({ code: "custom", path: ["raw"], message: "Invalid accepted marking code" });
    }
  })
  .transform((item) => {
    if (item.code === null) return { ...item, code: null };
    try {
      const km = canonicalizeKm(item.raw);
      return { ...item, code: { ...item.code, canonicalRaw: km.raw } };
    } catch {
      return { ...item, code: { ...item.code, canonicalRaw: item.raw } };
    }
  });

const boxClosureSchema = z
  .object({
    // Scoped with shift/terminal because a device-local box id is not globally unique.
    boxId: z.string().min(1).max(64),
    shiftId: z.string().uuid().toLowerCase(),
    terminalId: z.string().nullable(),
    sscc: z.string().length(18),
    closedAt: z.string().datetime(),
    operatorId: z.string().uuid().toLowerCase().nullable(),
    // Defaults preserve compatibility with older stations that omit outcomes.
    printVerifiedAt: z.string().datetime().nullable().default(null),
    printSkippedAt: z.string().datetime().nullable().default(null),
  })
  .superRefine((closure, ctx) => {
    if (closure.printVerifiedAt !== null && closure.printSkippedAt !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["printSkippedAt"],
        message: "print verification outcomes are mutually exclusive",
      });
    }
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
  // Kept equal to the station drain size so the largest client-generated
  // payload remains below the API's JSON body ceiling.
  items: z.array(scanItemSchema).max(100),
  // Box closures carried by this batch. Independent of `items`: a box can
  // close well after its last item was drained, in a batch carrying no
  // items at all -- the drain is sequential, so the box row it refers to
  // (created by an earlier item's arrival, see boxes' schema comment)
  // already exists by the time its closure gets here.
  boxes: z
    .array(boxClosureSchema)
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
      z
        .object({
          kind: z.enum(["undo", "clear", "disassemble", "reprint"]),
          boxId: z.string().min(1).max(64),
          codeHash: z
            .string()
            .regex(/^[0-9a-f]{64}$/)
            .nullable(),
          targetScannedAt: z.string().datetime().nullable().default(null),
          shiftId: z.string().uuid().toLowerCase(),
          terminalId: z.string().nullable(),
          operatorId: z.string().uuid().toLowerCase().nullable(),
          reason: z.string().min(1).max(500).nullable(),
          occurredAt: z.string().datetime(),
        })
        .superRefine((exception, ctx) => {
          const codeShapeValid =
            exception.kind === "undo" ? exception.codeHash !== null : exception.codeHash === null;
          const targetShapeValid =
            exception.kind === "undo"
              ? exception.targetScannedAt !== null
              : exception.targetScannedAt === null;
          const reasonShapeValid =
            exception.kind === "undo" || exception.kind === "clear"
              ? exception.reason === null
              : exception.reason !== null;
          if (!codeShapeValid) {
            ctx.addIssue({
              code: "custom",
              path: ["codeHash"],
              message: "Invalid codeHash for exception kind",
            });
          }
          if (!reasonShapeValid) {
            ctx.addIssue({
              code: "custom",
              path: ["reason"],
              message: "Invalid reason for exception kind",
            });
          }
          if (!targetShapeValid) {
            ctx.addIssue({
              code: "custom",
              path: ["targetScannedAt"],
              message: "Invalid targetScannedAt for exception kind",
            });
          }
        }),
    )
    .max(200)
    .default([]),
});

/** Wire shape before server-derived canonicalRaw is attached by the parser. */
export type ScanItemDto = z.input<typeof scanItemSchema>;
export type SyncBatchDto = z.output<typeof syncBatchSchema>;

export const stationConflictStatusSchema = z.object({
  codeHashes: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .min(1)
    .max(200),
});
export type StationConflictStatusDto = z.infer<typeof stationConflictStatusSchema>;

export interface StationConflictStatusResponseDto {
  reviewedCodeHashes: string[];
}

/** A code in THIS batch that lost ownership to an earlier scan elsewhere. */
export interface BatchConflictDto {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

export interface DeniedStationRecordDto {
  recordKind: "item" | "box" | "exception";
  recordIndex: number;
  shiftId: string;
  code: "subscription_read_only" | "legacy_unbound_replay";
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
  /** Present only when the client negotiated station-recovery-v1. */
  denied?: DeniedStationRecordDto[];
}
