import {
  applyValidationOutcomes,
  parseValidationOutcomes,
  reconcileValidationOccurrences,
} from "./validation-reprocessing.js";
import { z } from "zod";
import {
  applyBoxReconciliationResults,
  readBoxReconciliationBatch,
  requestFullShiftReconciliation,
} from "./box-reconciliation.js";
import {
  readStationSavedEvidence,
  readStationEvidencePin,
  sendStationEvidence,
  stationEvidenceCommitExecutor,
  StationEvidenceRecoveryError,
} from "./offline-grants/evidence-store.js";
import { readStationChannelEvidence } from "./offline-grants/scan-evidence.js";
import type { SavedStationEvidenceLink } from "./offline-grants/evidence.js";
import { deviceRecoveryAllowsWork } from "./device-recovery.js";
import { purgeCompletedProductLabelJobs } from "./product-labels/retention.js";
import {
  MAX_BOX_CLOSURES_PER_SYNC_BATCH,
  MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
  MAX_PRODUCT_LABEL_EVENTS,
  MAX_SYNC_BATCH_ID_CHARS,
  productLabelValueDigest,
  productLabelEventSchema,
  type ProductLabelRejectionCode,
} from "@markiro/domain";
import {
  ackProductLabelEvents,
  readPendingProductLabelEvents,
  validateProductLabelReceipt,
  productLabelPendingStats,
  productLabelSetSignature,
} from "./product-labels/sync.js";
import {
  clearProductLabelBatchPin,
  readProductLabelBatchPin,
  saveProductLabelBatchPin,
  PRODUCT_LABEL_CEILING_KEY,
} from "./product-labels/sync-batch.js";
import { isStationCredentialRejection, type StationClient } from "./api-client.js";
import {
  conflictCount,
  CONFLICT_RECONCILE_BATCH_SIZE,
  readConflictHashesAfter,
  recordConflicts,
  removeReviewedConflicts,
} from "./conflicts.js";
import {
  acquireCredentialCommitLease,
  createCredentialGeneration,
  credentialGenerationOwnership,
  rejectCredentialGeneration,
  type CredentialGeneration,
  type CredentialRejectedEvent,
} from "./credential-recovery.js";
import { getInstallId } from "./install-id.js";
import type { SqlExecutor } from "./mirror.js";
import { ackThrough, oldestQueuedAt, outboxDepth, readBatch, type OutboxItem } from "./outbox.js";
import { addRange, remaining, type PoolRange } from "./sscc-pool.js";
import {
  ackExceptionsThrough,
  exceptionDepth,
  oldestExceptionAt,
  readExceptions,
  type PendingException,
} from "./box-exceptions-mirror.js";
import {
  markShiftCloseAccepted,
  markShiftCloseConflict,
  readPendingShiftCloses,
  type PendingShiftClose,
} from "./shift-close.js";
import {
  ackPalletExceptionsThrough,
  oldestPalletExceptionAt,
  palletExceptionDepth,
  readPalletExceptions,
  type PendingPalletException,
} from "./pallets.js";
import { createShiftProgressTracker, type ShiftProgressSnapshot } from "./shift-progress.js";

const nullableCeiling = z.number().int().nonnegative().nullable();
const scanEvidenceCheckpointSchema = z.object({
  scanRows: z.array(
    z.object({
      id: z.number().int().positive(),
      shiftId: z.string(),
      terminalId: z.string().nullable(),
      raw: z.string(),
      verdict: z.string(),
      scannedAt: z.string(),
      code: z.object({ codeHash: z.string(), gtin14: z.string(), serial: z.string() }).nullable(),
      boxId: z.string().nullable(),
      operatorId: z.string().nullable(),
    }),
  ),
  maxId: nullableCeiling,
  boxCeiling: nullableCeiling,
  exceptionCeiling: nullableCeiling,
  palletCeiling: nullableCeiling,
  palletExceptionCeiling: nullableCeiling,
  labelCeiling: nullableCeiling,
  boxes: z.array(
    z.object({
      boxId: z.string(),
      printVerifiedAt: z.string().nullable(),
      printSkippedAt: z.string().nullable(),
    }),
  ),
  pallets: z.array(
    z.object({
      palletId: z.string(),
      shiftId: z.string(),
      terminalId: z.string().nullable(),
      sscc: z.string(),
      closedAt: z.string(),
      operatorId: z.string().nullable(),
      printVerifiedAt: z.string().nullable(),
      printSkippedAt: z.string().nullable(),
      rowid: z.number(),
    }),
  ),
  labelEvents: z.array(productLabelEventSchema),
});

export { MAX_BOX_CLOSURES_PER_SYNC_BATCH, MAX_PALLET_CLOSURES_PER_SYNC_BATCH };

/** Scans per request. Small enough to survive a flaky link and to retry cheaply. */
export const BATCH_SIZE = 100;
/** How long a non-empty queue may stop moving before the operator is warned. */
export const STUCK_AFTER_MS = 15 * 60 * 1000;
/**
 * Exported so tests that deliberately fail a batch can wait out the
 * engine's own scheduled retry (rather than guessing a delay) before
 * exercising something that depends on no retry being pending — e.g. proving
 * a `nudge()` from elsewhere (the `online` listener, `App.test.tsx`'s
 * "nudges ... online" test) actually starts a drain, which it only does once
 * the backoff-respecting `nudge()` (Finding 1) has nothing scheduled to
 * defer to.
 */
export const BACKOFF_START_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

export interface SyncState {
  pending: number;
  lastSuccessAt: number | null;
  /** The queue has work and has stopped moving — "the pipe is broken". */
  stuck: boolean;
  /**
   * How many of this device's own scans lost ownership to an earlier scan
   * elsewhere. Not an alarm — the operator already saw a green verdict for
   * each one — so this is a quiet count, never something that interrupts.
   */
  conflicts: number;
  /**
   * Unburned SSCC serials left in this device's local pool (box ranges,
   * extension digit 0), summed across every range it holds. Zero when the
   * device has never received a range at all, same as a dry pool — the
   * operator-facing signal (a later slice) has no reason to tell those
   * apart.
   */
  serialsLeft: number;
  /**
   * The last server answer for the shift the work screen watches (null when
   * none is watched or none arrived yet). See `shift-progress.ts`.
   */
  shiftProgress: ShiftProgressSnapshot | null;
}

async function drainShiftCloseRows(
  exec: SqlExecutor,
  client: Pick<StationClient, "post">,
  rows: PendingShiftClose[],
  generation: CredentialGeneration,
): Promise<void> {
  for (const row of rows) {
    if (!(await deviceRecoveryAllowsWork(exec, generation))) return;
    const payload = {
      eventId: row.event_id,
      shiftId: row.shift_id,
      operatorId: row.operator_id,
      plannedQtySnapshot: row.planned_qty_snapshot,
      actualQty: row.actual_qty,
      closedBoxCount: row.closed_box_count,
      reasonCode: row.reason_code,
      closedAt: row.closed_at,
    };
    const evidence = await readStationSavedEvidence(exec, [
      { eventId: row.event_id, pointer: "/#shift.close.v1" },
    ]);
    const value = evidence.negotiated
      ? await sendStationEvidence({
          exec,
          client,
          generation,
          key: `shift-close:${row.event_id}`,
          path: "/station/grants/v1/evidence/shift-closures",
          batchId: row.event_id,
          payload,
          links: evidence.links,
        })
      : await client.post("/station/shift-closures", payload);
    const response = z
      .object({
        outcome: z.enum(["accepted", "already_resolved", "conflict"]),
        conflictCode: z.literal("multiple_devices").optional(),
      })
      .parse(value);
    if (!(await deviceRecoveryAllowsWork(exec, generation))) return;
    const lease = acquireCredentialCommitLease(generation);
    if (!lease) return;
    try {
      const pin = evidence.negotiated
        ? await readStationEvidencePin(exec, generation, `shift-close:${row.event_id}`)
        : null;
      const writer = evidence.negotiated
        ? await stationEvidenceCommitExecutor(exec, generation, pin?.credentialOwnership)
        : exec;
      if (response.outcome === "conflict") {
        await markShiftCloseConflict(
          writer,
          row.event_id,
          response.conflictCode ?? "multiple_devices",
        );
      } else {
        await markShiftCloseAccepted(writer, row.event_id);
      }
    } finally {
      lease.release();
    }
  }
}

export interface SyncEngineDeps {
  exec: SqlExecutor;
  client: Pick<StationClient, "post"> & Partial<Pick<StationClient, "get">>;
  /** Always present in the station config; makes the batch id unique per device. */
  machineId: string;
  now?: () => number;
  onState(state: SyncState): void;
  /** Shared by every engine using the same durable API-key generation. */
  credentialGeneration?: CredentialGeneration;
  /** Terminal notification for a server-rejected device credential. */
  onCredentialRejected?: (event: CredentialRejectedEvent) => void;
}

export interface SyncEngine {
  /** Ask for a drain. Safe to call from anywhere, any number of times. */
  nudge(): void;
  /** Freeze local sync commits; an in-flight server response becomes a retry. */
  pause(): void;
  /** Pause immediately, then resolve only after every in-flight network/commit phase retires. */
  pauseAndWaitForIdle(): Promise<void>;
  /** Lift a prior pause and immediately retry any durable pending work. */
  resume(): void;
  stop(): void;
  /** Resolves when no drain is in flight (tests await this instead of sleeping). */
  idle(): Promise<void>;
  /** Persist an audit request and let the device-wide worker perform it. */
  requestFullShiftAudit(shiftId?: string): Promise<void>;
  /** Wait for one scheduled drain/reconciliation pass, without bypassing backoff. */
  reconcileNow(): Promise<void>;
  /**
   * Which shift's total to fetch after drains; null stops. Publishes that
   * shift's persisted answer at once. Does not nudge.
   */
  watchShiftProgress(shiftId: string | null): void;
}

/** One of this device's scans that lost ownership, as the server reports it. */
interface BatchConflict {
  codeHash: string;
  winningTerminalId: string | null;
  winningScannedAt: string;
}

/** A block of box-range serials the server is topping this device's pool up with. */
type BatchSsccBlock = Omit<PoolRange, "nextSerial">;

interface BatchResponse {
  applied: number;
  alreadyApplied: boolean;
  conflicts?: BatchConflict[];
  ssccBlock?: BatchSsccBlock;
  denied?: DeniedStationRecord[];
  productLabelReceipt?: unknown;
  validationOccurrences?: unknown;
}

interface ConflictStatusResponse {
  reviewedCodeHashes: string[];
}

interface CodeReleaseResponse {
  until: string;
  releasedCodeHashes: string[];
  nextCursor?: string;
}

const boxReconciliationResponseSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      boxId: z.string(),
      status: z.enum(["confirmed", "replay_required", "content_mismatch", "identity_conflict"]),
      reasonCode: z.string(),
      serverItemCount: z.number().int().nonnegative().nullable(),
    }),
  ),
});

/**
 * `pallet` and `pallet_exception` are carried here, not only server-side:
 * `isDeniedStationRecord` FILTERS kinds it does not recognize, so a device
 * that never learned these two would silently discard the quarantine notice
 * for a pallet the server refused -- while still acknowledging (and deleting)
 * the rows that produced it. The operator would never learn that a physically
 * labelled pallet never landed.
 */
interface DeniedStationRecord {
  recordKind: "item" | "box" | "exception" | "product_label_event" | "pallet" | "pallet_exception";
  recordIndex: number;
  shiftId: string;
  code: ProductLabelRejectionCode | "legacy_unbound_replay";
}

/**
 * `winningScannedAt` must be a string AND parse to a real instant. A
 * non-ISO string would otherwise ride through unchanged into
 * `conflicts_mirror` and blow up `ConflictList`'s `Intl.DateTimeFormat` at
 * render time (`new Date("garbage")` is an Invalid Date, and `.format()` on
 * one throws a `RangeError`) -- taking the whole list down for one bad
 * entry. `.filter(isBatchConflict)` already drops entries one at a time, so
 * this costs only the malformed conflict, never its batch-mates. That cost
 * is real, though: a dropped conflict is gone for good, since a resent
 * already-applied batch answers `conflicts: []` (see the module doc
 * comment above), so there is no second chance to record it.
 */
function isBatchConflict(value: unknown): value is BatchConflict {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.codeHash === "string" &&
    (typeof c.winningTerminalId === "string" || c.winningTerminalId === null) &&
    typeof c.winningScannedAt === "string" &&
    !Number.isNaN(Date.parse(c.winningScannedAt))
  );
}

function isCodeHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isConflictStatusResponse(value: unknown): value is ConflictStatusResponse {
  if (typeof value !== "object" || value === null) return false;
  const reviewed = (value as Record<string, unknown>).reviewedCodeHashes;
  return Array.isArray(reviewed) && reviewed.every(isCodeHash);
}

function isRegistryRevision(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/.test(value)) return false;
  try {
    return BigInt(value) <= 9_223_372_036_854_775_807n;
  } catch {
    return false;
  }
}

function isCodeReleaseResponse(value: unknown): value is CodeReleaseResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    isRegistryRevision(response.until) &&
    Array.isArray(response.releasedCodeHashes) &&
    response.releasedCodeHashes.every(isCodeHash) &&
    (response.nextCursor === undefined ||
      (typeof response.nextCursor === "string" && response.nextCursor.length > 0))
  );
}

const CODE_RELEASE_REVISION_META_KEY = "code_release_revision";

async function removeReleasedCodes(exec: SqlExecutor, codeHashes: string[]): Promise<void> {
  const unique = [...new Set(codeHashes)];
  if (unique.length === 0) return;
  const placeholders = unique.map(() => "?").join(", ");
  await exec.run(`DELETE FROM codes_mirror WHERE code_hash IN (${placeholders})`, unique);
}

async function reconcileReleasedCodes(
  exec: SqlExecutor,
  client: Pick<StationClient, "post">,
): Promise<void> {
  const localCodes = await exec.all<{ present: number }>(
    `SELECT 1 AS present FROM codes_mirror
      WHERE length(code_hash) = 64
        AND code_hash NOT GLOB '*[^0-9a-f]*'
      LIMIT 1`,
  );
  if (localCodes.length === 0) return;

  const persisted = await loadPersistedValue(exec, CODE_RELEASE_REVISION_META_KEY);
  const since = isRegistryRevision(persisted) ? persisted : "0";
  let until: string | null = null;
  let cursor: string | null = null;
  for (;;) {
    const body: { since: string; until?: string; cursor?: string } =
      cursor === null || until === null ? { since } : { since, until, cursor };
    const response: unknown = await client.post<unknown>("/station/codes/releases", body);
    if (!isCodeReleaseResponse(response) || BigInt(response.until) < BigInt(since)) {
      throw new Error("station: unexpected /station/codes/releases response shape");
    }
    if (until !== null && response.until !== until) {
      throw new Error("station: code release snapshot changed during pagination");
    }
    await removeReleasedCodes(exec, response.releasedCodeHashes);
    if (response.nextCursor === undefined) {
      await savePersistedValue(exec, CODE_RELEASE_REVISION_META_KEY, response.until);
      return;
    }
    if (response.nextCursor === cursor) {
      throw new Error("station: code release cursor did not advance");
    }
    until = response.until;
    cursor = response.nextCursor;
  }
}

async function reconcileReviewedConflicts(
  exec: SqlExecutor,
  client: Pick<StationClient, "post">,
): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const codeHashes = await readConflictHashesAfter(exec, cursor);
    if (codeHashes.length === 0) return;
    const response = await client.post<unknown>("/station/conflicts/status", { codeHashes });
    if (!isConflictStatusResponse(response)) {
      throw new Error("station: unexpected /station/conflicts/status response shape");
    }
    const requested = new Set(codeHashes);
    const reviewed = response.reviewedCodeHashes.filter((codeHash) => requested.has(codeHash));
    await removeReviewedConflicts(exec, reviewed);
    cursor = codeHashes.at(-1)!;
    if (codeHashes.length < CONFLICT_RECONCILE_BATCH_SIZE) return;
  }
}

function isDeniedStationRecord(value: unknown): value is DeniedStationRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    ["item", "box", "exception", "product_label_event", "pallet", "pallet_exception"].includes(
      String(record.recordKind),
    ) &&
    Number.isInteger(record.recordIndex) &&
    Number(record.recordIndex) >= 0 &&
    typeof record.shiftId === "string" &&
    [
      "subscription_read_only",
      "legacy_unbound_replay",
      "parent_missing",
      "policy_mismatch",
      "ownership_conflict",
      "invalid_transition",
      "sequence_gap",
    ].includes(String(record.code))
  );
}

/**
 * Same discipline as `isBatchConflict`, for the same reason: `ssccBlock` is
 * optional, and a malformed one must cost only the top-up, never the batch's
 * ack. Checked at the point of consumption (below), not folded into
 * `isBatchResponse` itself — that guard's two required fields are what
 * stand between a captive portal and a permanent delete, and this is not
 * that; a server that sends a top-up in a shape this device does not
 * recognize should still see its batch acknowledged.
 */
function isBatchSsccBlock(value: unknown): value is BatchSsccBlock {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Record<string, unknown>;
  return (
    typeof b.issuerPrefix === "string" &&
    typeof b.extensionDigit === "number" &&
    typeof b.fromSerial === "number" &&
    typeof b.toSerial === "number"
  );
}

/**
 * Guards against acknowledging (and permanently deleting) a batch on the
 * strength of a response that merely parsed as JSON but isn't actually this
 * endpoint's contract — e.g. a captive portal or maintenance shim on the
 * plant network answering `200 {"status":"ok"}` instead of the server.
 *
 * The two original fields stay REQUIRED: this guard is what stands between a
 * captive portal's `200 {"status":"ok"}` and an acknowledgement that
 * permanently deletes scans. `conflicts` is tolerated when absent or
 * malformed — a server that cannot describe conflicts must not cost the
 * device its delivery — and is filtered element-by-element where it is
 * consumed, not validated here.
 */
function isBatchResponse(value: unknown): value is BatchResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { applied?: unknown }).applied === "number" &&
    typeof (value as { alreadyApplied?: unknown }).alreadyApplied === "boolean"
  );
}

function toPayload(items: OutboxItem[]) {
  return items.map((i) => ({
    shiftId: i.shiftId,
    terminalId: i.terminalId,
    raw: i.raw,
    verdict: i.verdict,
    scannedAt: i.scannedAt,
    code: i.code,
    boxId: i.boxId,
    operatorId: i.operatorId,
  }));
}

function toExceptionPayload(exceptions: PendingException[]) {
  return exceptions.map((exception) => ({
    kind: exception.kind,
    boxId: exception.boxId,
    codeHash: exception.codeHash,
    targetScannedAt: exception.targetScannedAt,
    shiftId: exception.shiftId,
    terminalId: exception.terminalId,
    operatorId: exception.operatorId,
    reason: exception.reason,
    occurredAt: exception.at,
  }));
}

/** Keeps the contiguous id prefix required by range-based acknowledgements. */
function takePrefix<T>(rows: T[], keep: (row: T) => boolean): T[] {
  const stop = rows.findIndex((row) => !keep(row));
  return stop === -1 ? rows : rows.slice(0, stop);
}

/** A closed-but-unreported box, as read off this device's own `boxes_mirror` row. */
interface BoxClosureRow {
  boxId: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string;
  closedAt: string;
  operatorId: string | null;
  /**
   * Whether the closed box's printed label has been scanned back and
   * matched, or the operator explicitly chose to skip that (Task 13 review,
   * Finding 6) -- read straight off `boxes_mirror`'s own `print_verified_at`/
   * `print_skipped_at` columns (Task 9), which is where `PrintVerification`'s
   * `onVerified`/`onSkip` paths write them. Null on either just means "not
   * yet resolved" -- an ack can race the operator's decision (the box is
   * typically acked within seconds of closing, often before the prompt is
   * even answered), and that is fine: there is no requirement that the
   * outcome reach the server before the ack, only that it eventually can.
   */
  printVerifiedAt: string | null;
  printSkippedAt: string | null;
  /**
   * The pallet this box stands on, as the DEVICE names it (`boxes_mirror`'s
   * own `pallet_id`, written by `joinPallet`), or null for a box on a
   * pallet-less shift. The server resolves it into a real pallet row in the
   * SAME statement that applies the closure -- see `devicePalletId` in the
   * API's `boxClosureSchema`.
   */
  devicePalletId: string | null;
  /** Zero on first delivery; reconciliation advances this before requeueing a closure. */
  lastCheckedRevision: number;
  /** SQLite's own rowid -- see `readClosedUnackedBoxes`'s doc comment. */
  rowid: number;
}

/**
 * Every box this device has closed but not yet had acknowledged, oldest
 * first -- capped at `limit` (the API's own `syncBatchSchema.boxes.max()`,
 * `MAX_BOX_CLOSURES_PER_SYNC_BATCH`) so a station that closes more boxes
 * offline than one batch may carry never assembles a payload the server
 * rejects outright: without this cap, an over-limit batch would 400 every
 * time (Zod's `.max()`), and since the drain treats every error as
 * retryable and never drops data (see the module doc comment), the
 * identical oversized payload would retry forever, wedging both box
 * closures and item delivery on that device. The drain loop's own `for`
 * loop is what delivers anything left over: once this capped batch acks,
 * the next iteration reads fresh and picks up the remainder.
 *
 * `ceilingRowid`, when given, additionally requires `rowid <= ceilingRowid`
 * -- the same discipline `readBatch`'s `ceilingId` applies to the outbox
 * (see `pendingBoxCeiling`'s doc comment in `createSyncEngine` for why a box
 * closure needs this too, despite being idempotent on the server): a retry
 * of a batch already in flight must re-read the EXACT box set that batch's
 * id was computed from, never a fresh read that could have grown to include
 * a box that closed during the backoff window. Omitted (or `null`), this is
 * a plain "oldest `limit` rows" read, used only when no box batch is
 * currently pinned.
 *
 * Reports `shiftId`/`terminalId` straight off the box's OWN row, never
 * whatever the device would consider "current" at drain time: this engine
 * has no notion of a "current" shift or terminal at all (it drains the
 * WHOLE device outbox, which can span a shift change), and terminalId
 * (`deviceId`) lives in `station.json`, not this SQLite mirror, so it can
 * change independently of a box still open in the local database. A box
 * spanning either change must still report the identity it was opened
 * under, or the server's four-column match can never find it.
 */
async function readClosedUnackedBoxes(
  exec: SqlExecutor,
  limit: number,
  ceilingRowid?: number | null,
): Promise<BoxClosureRow[]> {
  const columns = `SELECT rowid, box_id, shift_id, terminal_id, sscc, closed_at, closed_by,
                  print_verified_at, print_skipped_at, pallet_id, last_checked_revision
             FROM boxes_mirror`;
  const rows =
    ceilingRowid != null
      ? await exec.all<BoxClosureSqlRow>(
          `${columns}
            WHERE closed_at IS NOT NULL AND acked_at IS NULL AND rowid <= ?
            ORDER BY rowid LIMIT ?`,
          [ceilingRowid, limit],
        )
      : await exec.all<BoxClosureSqlRow>(
          `${columns}
            WHERE closed_at IS NOT NULL AND acked_at IS NULL
            ORDER BY rowid LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    boxId: r.box_id,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    sscc: r.sscc,
    closedAt: r.closed_at,
    operatorId: r.closed_by,
    printVerifiedAt: r.print_verified_at,
    printSkippedAt: r.print_skipped_at,
    devicePalletId: r.pallet_id,
    lastCheckedRevision: r.last_checked_revision,
    rowid: r.rowid,
  }));
}

interface BoxClosureSqlRow {
  box_id: string;
  shift_id: string;
  terminal_id: string | null;
  sscc: string;
  closed_at: string;
  closed_by: string | null;
  print_verified_at: string | null;
  print_skipped_at: string | null;
  pallet_id: string | null;
  last_checked_revision: number;
  rowid: number;
}

function toBoxPayload(boxes: BoxClosureRow[]) {
  return boxes.map((b) => ({
    boxId: b.boxId,
    shiftId: b.shiftId,
    terminalId: b.terminalId,
    sscc: b.sscc,
    closedAt: b.closedAt,
    operatorId: b.operatorId,
    printVerifiedAt: b.printVerifiedAt,
    printSkippedAt: b.printSkippedAt,
    devicePalletId: b.devicePalletId,
  }));
}

/** A closed-but-unreported pallet, read off this device's own `pallets_mirror` row. */
interface PalletClosureRow {
  palletId: string;
  shiftId: string;
  terminalId: string | null;
  sscc: string;
  closedAt: string;
  operatorId: string | null;
  printVerifiedAt: string | null;
  printSkippedAt: string | null;
  /** SQLite's own rowid -- see `readClosedUnackedPallets`'s doc comment. */
  rowid: number;
}

/**
 * Every pallet this device has closed but not yet had acknowledged, oldest
 * first -- `readClosedUnackedBoxes`'s exact counterpart, and every word of
 * that function's doc comment applies here with `MAX_PALLET_CLOSURES_PER_SYNC_
 * BATCH` (the API's own `syncBatchSchema.pallets.max()`) in place of the box
 * limit: a device that closes more pallets offline than one batch may carry
 * must never assemble a payload the server rejects outright, because the drain
 * treats every error as retryable and would resend that identical oversized
 * payload forever, wedging pallets, boxes AND item delivery together.
 *
 * `sscc IS NOT NULL` is in the match, unlike the box read: `closePallet` writes
 * `sscc` and `closed_at` in one guarded UPDATE, so the two cannot disagree
 * today -- but the server's `palletClosureSchema` requires an 18-digit `sscc`,
 * and a row that somehow reached `closed_at` without one would 400 the whole
 * batch on every retry. Skipping it costs one unreportable pallet; carrying it
 * costs the device its entire delivery.
 *
 * `disassembled_at IS NULL` is NOT in the match, deliberately: a pallet that
 * was closed, labelled, and then retired still has to reach the server as a
 * closure, or the exception that retires it names a pallet the server was
 * never told about (its `pallet_exception_disassemble_local` trigger marks the
 * mirror row locally the instant the fact is queued, long before either
 * reaches the server). The server's own pre-pass creates a pallet from either
 * record, so the two arrive in whatever order the batches carry them.
 *
 * Reports `shiftId`/`terminalId` straight off the pallet's OWN row for the
 * same reason the box read does: this engine drains the whole device and has
 * no notion of a "current" shift or terminal.
 */
async function readClosedUnackedPallets(
  exec: SqlExecutor,
  limit: number,
  ceilingRowid?: number | null,
): Promise<PalletClosureRow[]> {
  const columns = `SELECT rowid, pallet_id, shift_id, terminal_id, sscc, closed_at, closed_by,
                  print_verified_at, print_skipped_at
             FROM pallets_mirror`;
  const rows =
    ceilingRowid != null
      ? await exec.all<PalletClosureSqlRow>(
          `${columns}
            WHERE closed_at IS NOT NULL AND sscc IS NOT NULL AND acked_at IS NULL AND rowid <= ?
            ORDER BY rowid LIMIT ?`,
          [ceilingRowid, limit],
        )
      : await exec.all<PalletClosureSqlRow>(
          `${columns}
            WHERE closed_at IS NOT NULL AND sscc IS NOT NULL AND acked_at IS NULL
            ORDER BY rowid LIMIT ?`,
          [limit],
        );
  return rows.map((r) => ({
    palletId: r.pallet_id,
    shiftId: r.shift_id,
    terminalId: r.terminal_id,
    sscc: r.sscc,
    closedAt: r.closed_at,
    operatorId: r.closed_by,
    printVerifiedAt: r.print_verified_at,
    printSkippedAt: r.print_skipped_at,
    rowid: r.rowid,
  }));
}

interface PalletClosureSqlRow {
  pallet_id: string;
  shift_id: string;
  terminal_id: string | null;
  sscc: string;
  closed_at: string;
  closed_by: string | null;
  print_verified_at: string | null;
  print_skipped_at: string | null;
  rowid: number;
}

function toPalletPayload(pallets: PalletClosureRow[]) {
  return pallets.map((p) => ({
    palletId: p.palletId,
    shiftId: p.shiftId,
    terminalId: p.terminalId,
    sscc: p.sscc,
    closedAt: p.closedAt,
    operatorId: p.operatorId,
    printVerifiedAt: p.printVerifiedAt,
    printSkippedAt: p.printSkippedAt,
  }));
}

function toPalletExceptionPayload(exceptions: PendingPalletException[]) {
  return exceptions.map((exception) => ({
    kind: exception.kind,
    palletId: exception.palletId,
    shiftId: exception.shiftId,
    terminalId: exception.terminalId,
    operatorId: exception.operatorId,
    reason: exception.reason,
    occurredAt: exception.occurredAt,
  }));
}

/**
 * A compact identity for a set of box closures, folded into `batchId` so a
 * retry's key changes whenever the SET actually being sent changes (Finding
 * 1) -- either because a box was added (the ceiling rowid grows) or because
 * an already-included box's print-verification outcome resolved (Task 13
 * review, Finding 1's `acked_at`-clearing resend, which reuses the SAME
 * rowid). The checked revision is zero on original delivery and advances
 * before reconciliation requeues a closure, so a repair cannot reuse the
 * server's already-claimed box-only batch id. Long signatures are bounded
 * by `boundedBatchId` before transport.
 */
function boxSetSignature(boxes: BoxClosureRow[]): string {
  const ceiling = boxes[boxes.length - 1]!.rowid;
  const outcomes = boxes
    .map((b) => (b.printVerifiedAt !== null ? "v" : b.printSkippedAt !== null ? "s" : "u"))
    .join("");
  const base = `${ceiling}:${outcomes}`;
  const checkedRevisions = boxes.map((box) => box.lastCheckedRevision);
  return checkedRevisions.some((revision) => revision > 0)
    ? `${base}:${checkedRevisions.join(",")}`
    : base;
}

/**
 * Marks each of these boxes acknowledged -- CONDITIONALLY (CodeRabbit PR33
 * review, Finding 6): only if its print-verification outcome still matches
 * what was actually read into the payload this ack is FOR, at
 * payload-build time (`boxes`, the exact rows `readClosedUnackedBoxes`
 * returned for this send). One UPDATE per box, not a single IN-list
 * statement, because each box's own `printVerifiedAt`/`printSkippedAt` at
 * that moment can differ from its batch-mates', so one shared WHERE cannot
 * express every box's own condition at once.
 *
 * The race this closes: `markPrintVerified`/`markPrintSkipped` can resolve
 * a box's outcome AFTER its closure has already been read into an
 * in-flight upload's payload but BEFORE that upload's response is
 * acknowledged. Both of those functions clear `acked_at` on their own write
 * (see their own doc comments) specifically to re-open a resend window --
 * but an unconditional ack here would immediately re-close that SAME
 * window on the strength of a response that was for the OLD (still-null)
 * outcome, permanently losing the just-recorded resolution (it would never
 * be read by `readClosedUnackedBoxes` again). Gating on the STALE values
 * captured at payload-build time means: if the row's outcome is unchanged
 * since then, this ack lands normally; if it changed in that window, this
 * ack is correctly a no-op -- the row stays unacked and the next drain
 * resends it, carrying the real, now-resolved outcome.
 *
 * `IS`, not `=`, for both comparisons: SQLite's `=` is never true against
 * NULL (three-valued logic), so a box whose outcome was -- and still is --
 * unresolved (both columns null) would never match its own WHERE under
 * `=`. `IS` is null-safe, so `print_verified_at IS NULL` correctly matches
 * a still-null column.
 */
async function ackBoxes(
  exec: SqlExecutor,
  boxes: Array<Pick<BoxClosureRow, "boxId" | "printVerifiedAt" | "printSkippedAt">>,
  ackedAt: string,
): Promise<void> {
  for (const box of boxes) {
    await exec.run(
      `UPDATE boxes_mirror SET acked_at = ?
       WHERE box_id = ? AND print_verified_at IS ? AND print_skipped_at IS ?`,
      [ackedAt, box.boxId, box.printVerifiedAt, box.printSkippedAt],
    );
  }
}

/**
 * `boxSetSignature`'s exact counterpart for pallet closures, folded into
 * `batchId` beside it so a retry's key changes whenever the pallet SET being
 * sent changes -- either because a pallet was added (the ceiling rowid grows)
 * or because an already-included pallet's print-verification outcome resolved.
 *
 * This is what stops the failure the handheld already hit in its box form: the
 * server claims batch ids in `sync_batches` and short-circuits an
 * already-claimed one with `alreadyApplied` BEFORE its pallet loop
 * (`station-scans.service.ts`), so a retry whose pallet set silently grew
 * under an unchanged key would never have the new closure applied server-side
 * -- while `ackPallets` below marks it acknowledged anyway, losing a
 * physically labelled pallet for good.
 *
 * One character per pallet -- `u`nresolved, `v`erified, `s`kipped -- keeps
 * this well inside the batch id's budget at
 * `MAX_PALLET_CLOSURES_PER_SYNC_BATCH` pallets, and each pallet transitions
 * its character at most once (an outcome is terminal), so it cannot cycle back
 * to a signature already used for a genuinely different set.
 */
function palletSetSignature(pallets: PalletClosureRow[]): string {
  const ceiling = pallets[pallets.length - 1]!.rowid;
  const outcomes = pallets
    .map((p) => (p.printVerifiedAt !== null ? "v" : p.printSkippedAt !== null ? "s" : "u"))
    .join("");
  return `${ceiling}:${outcomes}`;
}

/**
 * Marks each of these pallets acknowledged, CONDITIONALLY, exactly as
 * `ackBoxes` does and for the same reason: a print-verification outcome can
 * resolve AFTER a closure has been read into an in-flight payload but BEFORE
 * that payload's response is acknowledged. Gating each UPDATE on the outcome
 * values captured at payload-build time makes this ack a no-op for a row that
 * changed in that window, so the next drain resends it carrying the resolved
 * outcome instead of the ack permanently closing the window on it.
 *
 * `IS`, not `=`: SQLite's `=` is never true against NULL, so a pallet whose
 * outcome was -- and still is -- unresolved would never match its own WHERE.
 */
async function ackPallets(
  exec: SqlExecutor,
  pallets: Array<Pick<PalletClosureRow, "palletId" | "printVerifiedAt" | "printSkippedAt">>,
  ackedAt: string,
): Promise<void> {
  for (const pallet of pallets) {
    await exec.run(
      `UPDATE pallets_mirror SET acked_at = ?
       WHERE pallet_id = ? AND print_verified_at IS ? AND print_skipped_at IS ?`,
      [ackedAt, pallet.palletId, pallet.printVerifiedAt, pallet.printSkippedAt],
    );
  }
}

/**
 * The issuer prefix this device's local pool is keyed under, or null if it
 * has never received a box range at all. A device holds at most one in
 * practice (`StationBundle.sscc` hands down a single prefix), so the lowest
 * one on an otherwise-unexpected multi-prefix device is as good a choice as
 * any -- this is a reporting figure, not an allocation decision.
 */
async function currentIssuerPrefix(exec: SqlExecutor): Promise<string | null> {
  const rows = await exec.all<{ issuer_prefix: string }>(
    "SELECT issuer_prefix FROM sscc_pool WHERE extension_digit = 0 ORDER BY issuer_prefix LIMIT 1",
  );
  return rows[0]?.issuer_prefix ?? null;
}

/** Serials left in the box pool (extension digit 0), for `SyncState` and the request body. */
async function computeSerialsLeft(exec: SqlExecutor): Promise<number> {
  const issuerPrefix = await currentIssuerPrefix(exec);
  return issuerPrefix === null ? 0 : remaining(exec, issuerPrefix, 0);
}

const CEILING_META_KEY = "sync_pending_ceiling";
/**
 * The box-closure counterpart of `CEILING_META_KEY` (Finding 1): pins the
 * `boxes_mirror` rowid ceiling of the box set currently in flight, the same
 * way `CEILING_META_KEY` pins the outbox `id` ceiling of the items in
 * flight. Without this, a batch that carries items keys its `batchId` off
 * `CEILING_META_KEY`'s `maxId` alone; if a NEW box closes while that batch
 * awaits acknowledgement, a retry would resend the identical `batchId` with
 * a grown box set. The server claims batch ids in `sync_batches` and
 * short-circuits an already-claimed one with `alreadyApplied` BEFORE its own
 * box-closures loop (`station-scans.service.ts`), so that new closure would
 * never actually be applied server-side -- yet this device's `ackBoxes` (see
 * `drain` below) marks it acknowledged anyway, losing it permanently. Pinning
 * the box set separately, exactly like the item ceiling, keeps a retry of
 * THIS batch scoped to the box set it was originally computed from; a box
 * that closes afterward rides a later, distinct batch instead.
 */
const BOX_CEILING_META_KEY = "sync_pending_box_ceiling";
const EXCEPTION_CEILING_META_KEY = "sync_pending_exception_ceiling";
/**
 * `BOX_CEILING_META_KEY`'s counterpart for pallet closures, and
 * `EXCEPTION_CEILING_META_KEY`'s for pallet exception facts. Both exist for
 * the reason spelled out above: a channel without its own pinned ceiling
 * silently grows its row set under a batch id the server has already claimed,
 * and the ack that follows deletes work the server never applied.
 */
const PALLET_CEILING_META_KEY = "sync_pending_pallet_ceiling";
const PALLET_EXCEPTION_CEILING_META_KEY = "sync_pending_pallet_exception_ceiling";
const BATCH_ID_META_KEY = "sync_pending_batch_id";
const RECOVERY_DENIED_META_KEY = "sync_last_recovery_denied";

/**
 * The batch id actually posted: the assembled key, or a deterministic digest
 * of it once it would exceed what the server's `syncBatchSchema.batchId`
 * accepts (`MAX_SYNC_BATCH_ID_CHARS`).
 *
 * The assembled form folds one signature per channel into the key so a retry
 * changes exactly when the SET being sent changes -- which makes its length
 * grow with what a batch may carry. With two UUID identity components
 * (`machineId` and the install id), `MAX_BOX_CLOSURES_PER_SYNC_BATCH` box
 * outcome characters, `MAX_PALLET_CLOSURES_PER_SYNC_BATCH` pallet ones and
 * both exception ceilings, a device whose row ids have grown over its
 * lifetime overflows that bound. An over-long key is not a cosmetic problem:
 * the server rejects it with a 400, and the drain -- which treats every error
 * as retryable and never drops data -- resends the identical key forever,
 * wedging every channel on that device.
 *
 * Folding it down preserves both properties the key has to have: the digest
 * is a pure function of the assembled key, so a retry of the same set
 * produces the same id, and two genuinely different sets keep different ids.
 * The `sync:` prefix keeps a folded key from ever colliding with a plain one
 * or with the `product-label:` form. Keys under the bound are returned
 * untouched, so this changes nothing for an ordinary batch.
 */
function boundedBatchId(batchId: string): string {
  if (batchId.length <= MAX_SYNC_BATCH_ID_CHARS) return batchId;
  return `sync:${productLabelValueDigest(batchId)}`;
}

async function loadPersistedValue(exec: SqlExecutor, key: string): Promise<string | null> {
  const rows = await exec.all<{ value: string | null }>(
    "SELECT value FROM station_meta WHERE key = ?",
    [key],
  );
  return rows[0]?.value ?? null;
}

/**
 * Reads back an in-flight batch's pinned ceiling (see `pendingCeiling`/
 * `pendingBoxCeiling` below), persisted in `station_meta` under `key` — the
 * same key/value table `hardware_config`, the roster slot pointer, and the
 * install id already use. This is what makes a ceiling survive not just the
 * engine's own scheduled retry within one process, but an app restart,
 * crash, or update: a brand-new engine, built over the same on-device
 * database, seeds its in-memory ceiling from here instead of starting at
 * `null` and reopening a plain fresh read — see `createSyncEngine`'s doc
 * comment for why that gap is exactly what let a resend duplicate data
 * server-side.
 */
async function loadPersistedCeiling(exec: SqlExecutor, key: string): Promise<number | null> {
  const value = await loadPersistedValue(exec, key);
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Single-statement upsert — the only atomic unit `tauri-plugin-sql`'s pooled
 * connections actually give us (a device-side BEGIN/COMMIT spanning two
 * calls is not a transaction; see `outbox.ts`'s `ackThrough` doc comment).
 * Called BEFORE the batch is posted, so a crash between this write landing
 * and the response arriving still leaves the ceiling pinned for whichever
 * process resends next.
 */
async function savePersistedCeiling(exec: SqlExecutor, key: string, id: number): Promise<void> {
  await savePersistedValue(exec, key, String(id));
}

async function savePersistedValue(exec: SqlExecutor, key: string, value: string): Promise<void> {
  await exec.run(
    `INSERT INTO station_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

/** Single statement; called once the server has confirmed the batch. */
async function clearPersistedCeiling(exec: SqlExecutor, key: string): Promise<void> {
  await exec.run("DELETE FROM station_meta WHERE key = ?", [key]);
}

/**
 * Drains the device outbox to the server, one batch at a time.
 *
 * Delivery is at-least-once: a batch is acknowledged locally only after the
 * server confirms it, so a lost response resends. Two things make that
 * actually safe, not just apparently safe:
 *
 * 1. The batch id — `<machineId>:<installId>:<highest outbox id in the
 *    batch>` — is deterministic for a GIVEN set of rows, and the server
 *    records it, so resending those exact rows is a no-op there. `installId`
 *    (`install-id.ts`) is a random identifier persisted in `station_meta`: it
 *    changes only when `station-mirror.db` itself is recreated, which is
 *    what keeps a device that lost just its local database — but kept
 *    `machineId`, which lives in `station.json` instead — from colliding
 *    with a batch key the server already recorded for the database it
 *    replaced (Finding 3: without this, the outbox's id counter restarting
 *    at 1 in the fresh database would silently reproduce an old key, and the
 *    server's `alreadyApplied: true` for it would delete brand-new scans).
 * 2. The set of rows a key names cannot silently grow, including across a
 *    restart. `pendingCeiling` pins the batch currently awaiting
 *    acknowledgement to its original `maxId`: a retry — the engine's own
 *    scheduled backoff attempt, one a later nudge triggers, or the very
 *    first drain of a BRAND-NEW engine (an app restart, crash, or update) —
 *    re-reads exactly that range (`readBatch`'s `ceilingId`), never a fresh
 *    `ORDER BY id LIMIT` read. While the queue holds fewer rows than
 *    `BATCH_SIZE` — the ordinary state on a continuously-draining line — a
 *    fresh read would otherwise pick up rows enqueued since the failed
 *    attempt and post them under a NEW key the server has never seen,
 *    applying the original rows a second time. The ceiling is therefore not
 *    just an in-memory guard: it is persisted in `station_meta` with a
 *    single-statement upsert BEFORE the batch is sent, cleared with a single
 *    statement once the server confirms, and reloaded from there by any
 *    engine that starts with nothing in memory yet — see
 *    `loadPersistedCeiling`/`savePersistedCeiling`/`clearPersistedCeiling`
 *    above. That is what makes this survive not only the process's own
 *    retries but a restart mid-batch.
 *
 * A random id per attempt (instead of both of the above) would silently turn
 * every lost response into duplicated data.
 *
 * Exactly one drain runs at a time; `draining` is set synchronously before
 * the first await, the same discipline `createScanQueue` uses, because two
 * drains would read overlapping batches and race their acknowledgements.
 * `nudge()` also never starts a fresh drain while a retry is already
 * scheduled, so a scan arriving while the link is down cannot turn the
 * documented 2s→60s backoff into one POST attempt per scan — see its own
 * comment.
 */
export function createSyncEngine(deps: SyncEngineDeps): SyncEngine {
  const now = deps.now ?? (() => Date.now());
  const credentialGeneration = deps.credentialGeneration ?? createCredentialGeneration();
  const productLabelOwnership = credentialGenerationOwnership(credentialGeneration);
  const shiftProgress = createShiftProgressTracker({
    exec: deps.exec,
    client: deps.client,
    now,
  });
  let draining = false;
  let stopped = false;
  let evidenceNeedsRecovery = false;
  let paused = false;
  // A pause permanently invalidates work that was already in flight. A
  // later resume must not make that old response committable again merely
  // because the boolean pause has been lifted.
  let pauseEpoch = 0;
  let credentialRejected = false;
  let requested = false;
  let lastSuccessAt: number | null = null;
  let backoffMs = BACKOFF_START_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleResolvers: (() => void)[] = [];
  // The state `onState` last received, and a counter bumped by every
  // `watchShiftProgress` call -- see `publishWatchedProgress`.
  let lastPublished: SyncState | null = null;
  let watchGeneration = 0;
  // The `maxId` of the batch currently awaiting acknowledgement, or `null`
  // when no batch is in flight. Set right before the batch is posted (and
  // persisted to `station_meta` at that same point — see
  // `savePersistedCeiling`), held across every retry of that SAME batch,
  // and cleared — in memory AND in `station_meta` — only once the server
  // has confirmed it. See the doc comment above and `readBatch`'s
  // `ceilingId` parameter.
  let pendingCeiling: number | null = null;
  // Whether `pendingCeiling` has been seeded from `station_meta` yet. A
  // freshly constructed engine (a new process after a restart, crash, or
  // update) starts with `pendingCeiling` unset in memory even though a
  // previous process may have persisted one; this makes the FIRST drain
  // load it before doing anything else, instead of every engine's first
  // batch after a restart silently reopening a plain fresh prefix read.
  let ceilingLoaded = false;
  // The `boxes_mirror` rowid ceiling of the box set currently awaiting
  // acknowledgement (Finding 1) -- `pendingCeiling`'s exact counterpart for
  // box closures, pinned and persisted the same way, for the same reason:
  // without it, a batch that also carries items keys its `batchId` off
  // `pendingCeiling` alone, so a box that closes while that batch is in
  // flight would silently ride an unchanged retry key straight past the
  // server's already-claimed-batch short-circuit. See `BOX_CEILING_META_KEY`
  // above and `readClosedUnackedBoxes`'s `ceilingRowid` parameter.
  let pendingBoxCeiling: number | null = null;
  // `ceilingLoaded`'s exact counterpart for `pendingBoxCeiling`.
  let boxCeilingLoaded = false;
  // Exception facts need the same persisted exact-set guarantee: otherwise
  // a restart can replay an acknowledged audit fact under a newly-grown key.
  let pendingExceptionCeiling: number | null = null;
  let pendingProductLabelCeiling: number | null = null;
  let productLabelCeilingLoaded = false;
  let exceptionCeilingLoaded = false;
  // `pendingBoxCeiling`/`pendingExceptionCeiling`'s counterparts for the two
  // pallet channels. A pallet carries a serial that is already on a physical
  // label, so letting its set grow under an in-flight key is the most
  // expensive version of this bug in the whole drain.
  let pendingPalletCeiling: number | null = null;
  let palletCeilingLoaded = false;
  let pendingPalletExceptionCeiling: number | null = null;
  let palletExceptionCeilingLoaded = false;
  let pendingBatchId: string | null = null;
  let batchIdLoaded = false;
  // Resolved once per engine instance and cached: the install id never
  // changes for the life of a given local database, so there is no reason
  // to re-query `station_meta` for every batch.
  let installId: string | null = null;

  async function ensureInstallId(): Promise<string> {
    if (installId === null) installId = await getInstallId(deps.exec);
    return installId;
  }

  async function ensurePendingCeiling(): Promise<number | null> {
    if (!ceilingLoaded) {
      pendingCeiling = await loadPersistedCeiling(deps.exec, CEILING_META_KEY);
      ceilingLoaded = true;
    }
    return pendingCeiling;
  }

  /** `ensurePendingCeiling`'s exact counterpart for `pendingBoxCeiling`. */
  async function ensurePendingBoxCeiling(): Promise<number | null> {
    if (!boxCeilingLoaded) {
      pendingBoxCeiling = await loadPersistedCeiling(deps.exec, BOX_CEILING_META_KEY);
      boxCeilingLoaded = true;
    }
    return pendingBoxCeiling;
  }

  async function ensurePendingExceptionCeiling(): Promise<number | null> {
    if (!exceptionCeilingLoaded) {
      pendingExceptionCeiling = await loadPersistedCeiling(deps.exec, EXCEPTION_CEILING_META_KEY);
      exceptionCeilingLoaded = true;
    }
    return pendingExceptionCeiling;
  }

  /**
   * `ensurePendingBoxCeiling`'s counterpart for `pendingPalletCeiling`, with
   * the upgrade guard `ensurePendingProductLabelCeiling` already carries: a
   * batch pinned by a station that predates this channel has a persisted
   * `sync_pending_batch_id` and no pallet ceiling at all. Seeding `0` -- an
   * explicitly EMPTY channel -- is what stops the first post-upgrade retry of
   * that batch from reading fresh pallet closures into an identity the server
   * has already claimed, acknowledging them against an `alreadyApplied` the
   * server decided before it ever looked at `pallets[]`.
   */
  async function ensurePendingPalletCeiling(): Promise<number | null> {
    if (!palletCeilingLoaded) {
      pendingPalletCeiling = await loadPersistedCeiling(deps.exec, PALLET_CEILING_META_KEY);
      if (pendingPalletCeiling === null && (await ensurePendingBatchId()) !== null)
        pendingPalletCeiling = 0;
      palletCeilingLoaded = true;
    }
    return pendingPalletCeiling;
  }

  /** `ensurePendingPalletCeiling`'s counterpart for pallet exception facts. */
  async function ensurePendingPalletExceptionCeiling(): Promise<number | null> {
    if (!palletExceptionCeilingLoaded) {
      pendingPalletExceptionCeiling = await loadPersistedCeiling(
        deps.exec,
        PALLET_EXCEPTION_CEILING_META_KEY,
      );
      if (pendingPalletExceptionCeiling === null && (await ensurePendingBatchId()) !== null)
        pendingPalletExceptionCeiling = 0;
      palletExceptionCeilingLoaded = true;
    }
    return pendingPalletExceptionCeiling;
  }

  async function ensurePendingBatchId(): Promise<string | null> {
    if (!batchIdLoaded) {
      pendingBatchId = await loadPersistedValue(deps.exec, BATCH_ID_META_KEY);
      batchIdLoaded = true;
    }
    return pendingBatchId;
  }

  async function ensurePendingProductLabelCeiling(): Promise<number | null> {
    if (!productLabelCeilingLoaded) {
      pendingProductLabelCeiling = await loadPersistedCeiling(deps.exec, PRODUCT_LABEL_CEILING_KEY);
      // A pre-feature pinned batch must not acquire new label events during an upgrade retry.
      if (pendingProductLabelCeiling === null && (await ensurePendingBatchId()) !== null)
        pendingProductLabelCeiling = 0;
      productLabelCeilingLoaded = true;
    }
    return pendingProductLabelCeiling;
  }

  function settleIdle() {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  async function rejectCredential(): Promise<void> {
    if (credentialRejected) return;
    // Terminal before the first await: no nudge, retry timer, or continuation
    // can start another request with the rejected client once the 401 is known.
    credentialRejected = true;
    stopped = true;
    requested = false;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    await rejectCredentialGeneration(
      { machineId: deps.machineId, generation: credentialGeneration },
      deps.onCredentialRejected,
    );
  }

  async function publishState(): Promise<void> {
    const owner = await productLabelOwnership;
    const labels = owner
      ? await productLabelPendingStats(deps.exec, owner)
      : { count: 0, oldest: null };
    const [
      scanPending,
      exceptionPending,
      palletExceptionPending,
      closePending,
      boxPendingRows,
      palletPendingRows,
    ] = await Promise.all([
      outboxDepth(deps.exec),
      exceptionDepth(deps.exec),
      palletExceptionDepth(deps.exec),
      deps.exec.all<{ n: number; oldest: string | null }>(
        "SELECT COUNT(*) AS n, MIN(closed_at) AS oldest FROM shift_close_outbox WHERE state = 'pending'",
      ),
      deps.exec.all<{ n: number; oldest: string | null }>(
        `SELECT COUNT(*) AS n, MIN(closed_at) AS oldest
           FROM boxes_mirror WHERE closed_at IS NOT NULL AND acked_at IS NULL`,
      ),
      // Same shape as the box query, and matched to `readClosedUnackedPallets`
      // so the operator's pending count never includes a row the drain would
      // not actually send.
      deps.exec.all<{ n: number; oldest: string | null }>(
        `SELECT COUNT(*) AS n, MIN(closed_at) AS oldest
           FROM pallets_mirror
          WHERE closed_at IS NOT NULL AND sscc IS NOT NULL AND acked_at IS NULL`,
      ),
    ]);
    const boxPending = boxPendingRows[0]?.n ?? 0;
    const palletPending = palletPendingRows[0]?.n ?? 0;
    const pending =
      scanPending +
      exceptionPending +
      palletExceptionPending +
      (closePending[0]?.n ?? 0) +
      boxPending +
      palletPending +
      labels.count;
    // Nothing queued is never "stuck", however long the link has been down.
    let stuck = false;
    if (pending > 0) {
      // The two comparisons below deliberately live in different time
      // domains and must never be compared against each other — mixing them
      // is exactly the bug this replaces. `lastSuccessAt` is stamped from
      // the injected `now()`, so it is only meaningful measured against a
      // later `now()` from that same source. The oldest queued scan's age,
      // by contrast, is always measured against `Date.now()`: `scanned_at`
      // is a wall-clock ISO timestamp, never relative to the injected clock.
      const [oldestScan, oldestException, oldestPalletException] = await Promise.all([
        oldestQueuedAt(deps.exec),
        oldestExceptionAt(deps.exec),
        oldestPalletExceptionAt(deps.exec),
      ]);
      const oldest =
        [
          oldestScan,
          oldestException,
          oldestPalletException,
          labels.oldest,
          closePending[0]?.oldest ?? null,
          boxPendingRows[0]?.oldest ?? null,
          palletPendingRows[0]?.oldest ?? null,
        ]
          .filter((value): value is string => value !== null)
          .sort()[0] ?? null;
      const oldestMs = oldest === null ? NaN : Date.parse(oldest);
      // A missing or unparseable timestamp must never masquerade as "very
      // old" via NaN comparisons — treat it as not stuck rather than
      // warning spuriously.
      const oldestQueuedIsStale =
        Number.isFinite(oldestMs) && Date.now() - oldestMs >= STUCK_AFTER_MS;

      // No false-alarm risk on a healthy restart: state is published only
      // after the drain loop completes, so a device that reconnects and
      // drains successfully already has `lastSuccessAt` set by the time
      // this runs.
      if (lastSuccessAt !== null) {
        // Finding 4: `lastSuccessAt` alone goes stale merely from IDLE time
        // with an empty, healthy queue — it says nothing about how long any
        // CURRENTLY queued scan has actually failed to move. Requiring the
        // oldest queued scan to ALSO be stale on the wall clock is what
        // stops the first newly recorded scan's first failed upload from
        // being reported stuck immediately just because the device happened
        // to sit idle for a while beforehand.
        stuck = oldestQueuedIsStale && now() - lastSuccessAt >= STUCK_AFTER_MS;
      } else {
        stuck = oldestQueuedIsStale;
      }
    }
    const conflicts = await conflictCount(deps.exec);
    const serialsLeft = await computeSerialsLeft(deps.exec);
    const progress = await shiftProgress.current();
    publish({
      pending,
      lastSuccessAt,
      stuck: stuck || evidenceNeedsRecovery,
      conflicts,
      serialsLeft,
      shiftProgress: progress,
    });
  }

  function publish(state: SyncState): void {
    lastPublished = state;
    deps.onState(state);
  }

  /**
   * Publishes the watched shift's persisted answer without waiting for a
   * drain: after a restart without network, a pending backoff retry holds the
   * next drain -- and with it the next full publication -- for up to a
   * minute. Only `shiftProgress` changes. Every other field belongs to the
   * drain loop and is republished exactly as it last published it; recounting
   * them out here could let a read that started before an acknowledgement
   * land after the loop's fresher post-drain state. Before the first full
   * publication there is nothing to merge into, and that publication reads
   * the watched shift's answer itself.
   */
  async function publishWatchedProgress(generation: number): Promise<void> {
    const progress = await shiftProgress.current();
    if (stopped || generation !== watchGeneration || lastPublished === null) return;
    if (lastPublished.shiftProgress === progress) return;
    publish({ ...lastPublished, shiftProgress: progress });
  }

  async function drain(): Promise<void> {
    if (draining || stopped || paused || credentialGeneration.sealed) return;
    draining = true;
    const drainPauseEpoch = pauseEpoch;
    const pauseInvalidated = () => paused || pauseEpoch !== drainPauseEpoch;
    try {
      drainLoop: for (;;) {
        if (stopped || pauseInvalidated() || credentialGeneration.sealed) break;
        if (!(await deviceRecoveryAllowsWork(deps.exec, credentialGeneration))) break;
        // A ceiling from a previous failed attempt on THIS batch — whether
        // pinned earlier in this same process or persisted by a process
        // that pinned it and then never got to clear it — re-reads exactly
        // that range; otherwise this is a plain fresh prefix.
        const pendingCloses = await readPendingShiftCloses(deps.exec);
        if (pendingCloses.length > 0) {
          await drainShiftCloseRows(deps.exec, deps.client, pendingCloses, credentialGeneration);
          if (credentialGeneration.sealed) break;
        }
        const ceiling = await ensurePendingCeiling();
        const owner = await productLabelOwnership;
        if (owner && !pauseInvalidated() && !credentialGeneration.sealed) {
          const cleanupLease = acquireCredentialCommitLease(credentialGeneration);
          if (cleanupLease) {
            try {
              await purgeCompletedProductLabelJobs(deps.exec, owner);
            } catch {
              console.warn("station: delivered print copies retained after cleanup failure");
            } finally {
              cleanupLease.release();
            }
          }
        }

        let labelPin = await readProductLabelBatchPin(deps.exec, owner);
        let batch = labelPin ? [] : await readBatch(deps.exec, BATCH_SIZE, ceiling);
        // Boxes ride along independently of the outbox ceiling above (see
        // `readClosedUnackedBoxes`'s doc comment) -- a shift's last box can
        // close with nothing left queued, and that closure must still reach
        // the server without waiting for some LATER scan to give the drain
        // a reason to run. Pinned to its OWN ceiling (Finding 1), the same
        // way `batch` is pinned to `ceiling`: a retry of this same attempt
        // must re-read the exact box set it was keyed to, never a fresh read
        // that could have grown to include a box closed during the backoff
        // window. Capped at `MAX_BOX_CLOSURES_PER_SYNC_BATCH` (Finding 2) so
        // this device can never assemble a payload the server's own
        // `syncBatchSchema.boxes.max()` would reject outright.
        const boxCeiling = await ensurePendingBoxCeiling();
        let boxes = labelPin
          ? []
          : await readClosedUnackedBoxes(deps.exec, MAX_BOX_CLOSURES_PER_SYNC_BATCH, boxCeiling);
        const exceptionCeiling = await ensurePendingExceptionCeiling();
        await ensurePendingBatchId();
        let exceptions = labelPin
          ? []
          : await readExceptions(deps.exec, BATCH_SIZE, exceptionCeiling);
        // Pallets ride along on the same terms as boxes: pinned to their own
        // ceiling so a retry re-reads the exact set its key was computed from,
        // and capped at the API's own `syncBatchSchema.pallets.max()`. A
        // product-label pin owns the whole request envelope, so nothing new
        // may join it -- the same reason `boxes`/`exceptions` empty out above.
        const palletCeiling = await ensurePendingPalletCeiling();
        let pallets = labelPin
          ? []
          : await readClosedUnackedPallets(
              deps.exec,
              MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
              palletCeiling,
            );
        const palletExceptionCeiling = await ensurePendingPalletExceptionCeiling();
        let palletExceptions = labelPin
          ? []
          : await readPalletExceptions(
              deps.exec,
              MAX_PALLET_CLOSURES_PER_SYNC_BATCH,
              palletExceptionCeiling,
            );
        const labelCeiling = await ensurePendingProductLabelCeiling();
        const priorEvidencePin = pendingBatchId
          ? await readStationEvidencePin(deps.exec, credentialGeneration, `scans:${pendingBatchId}`)
          : null;
        let negotiated =
          pendingBatchId !== null &&
          (await loadPersistedValue(deps.exec, "sync_pending_evidence_protocol")) ===
            "offline-grants-v1";
        const evidenceLinks: SavedStationEvidenceLink[] = [];

        if (pauseInvalidated() || credentialGeneration.sealed) break;

        // Corrections and scans share one logical timeline even though they
        // live in separate SQLite tables. On a fresh attempt, send only the
        // chronological prefix from whichever channel is oldest. This keeps
        // an offline scan -> undo/clear -> rescan sequence in that order,
        // instead of applying the newer rescan and then releasing it in one
        // mixed server transaction. Retries skip this split because their
        // persisted ceilings already pin the exact selected prefix.
        if (pendingBatchId === null && batch.length > 0 && exceptions.length > 0) {
          const firstScanAt = Date.parse(batch[0]!.scannedAt);
          const firstExceptionAt = Date.parse(exceptions[0]!.at);
          if (!Number.isFinite(firstScanAt)) {
            exceptions = [];
          } else if (!Number.isFinite(firstExceptionAt)) {
            batch = [];
          } else if (firstScanAt <= firstExceptionAt) {
            batch = takePrefix(batch, (item) => Date.parse(item.scannedAt) <= firstExceptionAt);
            exceptions = [];
          } else {
            exceptions = takePrefix(exceptions, (item) => Date.parse(item.at) < firstScanAt);
            batch = [];
          }
        }
        const readLease = acquireCredentialCommitLease(credentialGeneration);
        if (!readLease) break;
        let labelRows;
        try {
          labelRows =
            owner && !labelPin
              ? await readPendingProductLabelEvents(
                  deps.exec,
                  owner,
                  MAX_PRODUCT_LABEL_EVENTS,
                  labelCeiling,
                  batch.at(-1)?.id ?? 0,
                )
              : [];
        } finally {
          readLease.release();
        }
        let labelEvents = labelPin?.request.productLabelEvents ?? labelRows.map((row) => row.event);
        // Preserve old pins; only newly selected prefixes negotiate evidence. Each
        // channel stops at its first different protocol, so range ACK cannot jump it.
        if (pendingBatchId === null) {
          let selected: boolean | null = null;
          const prefix = async <T>(
            rows: T[],
            channel: "items" | "boxes" | "pallets" | "productLabelEvents",
            identity: (row: T) => string | number,
          ) => {
            const kept: T[] = [];
            for (const row of rows) {
              const evidence = await readStationChannelEvidence(
                deps.exec,
                channel,
                identity(row),
                kept.length,
              );
              selected ??= evidence.negotiated;
              if (evidence.negotiated !== selected) break;
              kept.push(row);
            }
            return kept;
          };
          batch = await prefix(batch, "items", (row) => row.id);
          boxes = await prefix(boxes, "boxes", (row) => row.boxId);
          pallets = await prefix(pallets, "pallets", (row) => row.palletId);
          labelRows = await prefix(labelRows, "productLabelEvents", (row) => row.event.eventId);
          labelEvents = labelRows.map((row) => row.event);
          negotiated = selected === true;
        }
        if (negotiated && !priorEvidencePin) {
          for (const [index, row] of batch.entries())
            evidenceLinks.push(
              ...(await readStationChannelEvidence(deps.exec, "items", row.id, index)).links,
            );
          for (const [index, row] of boxes.entries())
            evidenceLinks.push(
              ...(await readStationChannelEvidence(deps.exec, "boxes", row.boxId, index)).links,
            );
          for (const [index, row] of pallets.entries())
            evidenceLinks.push(
              ...(await readStationChannelEvidence(deps.exec, "pallets", row.palletId, index))
                .links,
            );
          for (const [index, row] of labelEvents.entries())
            evidenceLinks.push(
              ...(
                await readStationChannelEvidence(
                  deps.exec,
                  "productLabelEvents",
                  row.eventId,
                  index,
                )
              ).links,
            );
        }
        // A batch carrying product-label events is posted from the FROZEN
        // envelope `saveProductLabelBatchPin` stores, and that envelope has no
        // pallet channels at all. Anything read into `pallets`/
        // `palletExceptions` here would therefore be acknowledged on the
        // strength of a response to a payload that never contained it --
        // exactly the loss the pinned ceilings exist to prevent. Dropping them
        // from THIS batch delays nothing in practice: duplicate-DM printing is
        // a validation-mode shift, which allocates no box or pallet serials at
        // all, and the drain loop's next iteration picks these rows up as soon
        // as the label batch acks.
        if (labelEvents.length > 0) {
          pallets = [];
          palletExceptions = [];
        }
        if (pauseInvalidated() || credentialGeneration.sealed) break;
        if (
          !priorEvidencePin &&
          batch.length === 0 &&
          boxes.length === 0 &&
          exceptions.length === 0 &&
          pallets.length === 0 &&
          palletExceptions.length === 0 &&
          labelEvents.length === 0
        ) {
          if (
            ceiling !== null ||
            boxCeiling !== null ||
            exceptionCeiling !== null ||
            palletCeiling !== null ||
            palletExceptionCeiling !== null ||
            labelCeiling !== null ||
            pendingBatchId !== null
          ) {
            // Only reachable with a stale ceiling if the rows it pinned were
            // somehow removed without going through `ackThrough`/`ackBoxes`
            // below (or were already acknowledged by whichever process
            // posted them, and this one never learned that) — not expected,
            // but clearing it here (in memory and in `station_meta`) avoids
            // wedging every later drain on a ceiling that can never again be
            // satisfied. `continue`, not `break`: any rows queued above the
            // (now cleared) ceiling must drain in this same pass, not wait
            // for the next nudge or the 15-second heartbeat.
            const staleLease = acquireCredentialCommitLease(credentialGeneration);
            if (!staleLease) break;
            try {
              pendingCeiling = null;
              pendingBoxCeiling = null;
              pendingExceptionCeiling = null;
              pendingPalletCeiling = null;
              pendingPalletExceptionCeiling = null;
              pendingProductLabelCeiling = null;
              pendingBatchId = null;
              await clearPersistedCeiling(deps.exec, CEILING_META_KEY);
              await clearPersistedCeiling(deps.exec, BOX_CEILING_META_KEY);
              await clearPersistedCeiling(deps.exec, EXCEPTION_CEILING_META_KEY);
              await clearPersistedCeiling(deps.exec, PALLET_CEILING_META_KEY);
              await clearPersistedCeiling(deps.exec, PALLET_EXCEPTION_CEILING_META_KEY);
              await clearPersistedCeiling(deps.exec, PRODUCT_LABEL_CEILING_KEY);
              await clearPersistedCeiling(deps.exec, BATCH_ID_META_KEY);
            } finally {
              staleLease.release();
            }
            if (credentialGeneration.sealed) break;
            continue;
          }
          break;
        }

        // A zero ceiling explicitly pins an EMPTY channel. This matters when
        // another channel forms the batch: after a crash, a null ceiling
        // would read fresh rows into the already-persisted batch identity.
        let maxId = labelPin ? labelPin.scanCeiling : (batch.at(-1)?.id ?? null);
        let newBoxCeiling = labelPin ? labelPin.boxCeiling : (boxes.at(-1)?.rowid ?? null);
        let newExceptionCeiling = labelPin
          ? labelPin.exceptionCeiling
          : (exceptions.at(-1)?.id ?? null);
        // Null here still pins an explicitly EMPTY channel below (`?? 0`),
        // which is what stops a crash from letting fresh pallet rows join an
        // already-persisted batch identity on the next attempt.
        let newPalletCeiling = pallets.at(-1)?.rowid ?? null;
        let newPalletExceptionCeiling = palletExceptions.at(-1)?.id ?? null;
        let ackBoxRows: Array<Pick<BoxClosureRow, "boxId" | "printVerifiedAt" | "printSkippedAt">> =
          labelPin?.boxes ?? boxes;
        let newLabelCeiling = labelPin?.labelCeiling ?? labelRows.at(-1)?.id ?? null;
        let ackScanRows = batch;
        if (priorEvidencePin) {
          const checkpoint = scanEvidenceCheckpointSchema.parse(priorEvidencePin.checkpoint);
          ackScanRows = checkpoint.scanRows;
          maxId = checkpoint.maxId;
          newBoxCeiling = checkpoint.boxCeiling;
          newExceptionCeiling = checkpoint.exceptionCeiling;
          newPalletCeiling = checkpoint.palletCeiling;
          newPalletExceptionCeiling = checkpoint.palletExceptionCeiling;
          newLabelCeiling = checkpoint.labelCeiling;
          ackBoxRows = checkpoint.boxes;
          pallets = checkpoint.pallets;
          labelEvents = checkpoint.labelEvents;
        }
        // Pin BEFORE sending — in memory AND in `station_meta` (a single
        // upsert; never a multi-statement transaction, see the module doc
        // comment) — so that if the post fails, or the whole process dies
        // before it completes, every later attempt on this batch — the
        // scheduled retry, a nudge that lands while one is outstanding, or a
        // brand-new engine's first drain after a restart — re-requests
        // exactly this id range (and exactly these box/exception sets), never
        // a fresh read that could have grown past it.
        try {
          const preparationLease = acquireCredentialCommitLease(credentialGeneration);
          if (!preparationLease) break;
          let batchId: string;
          let serialsLeft: number;
          try {
            if (pendingBatchId === null) {
              if (negotiated)
                await savePersistedValue(
                  deps.exec,
                  "sync_pending_evidence_protocol",
                  "offline-grants-v1",
                );
              else await clearPersistedCeiling(deps.exec, "sync_pending_evidence_protocol");
            }
            pendingCeiling = maxId ?? 0;
            pendingBoxCeiling = newBoxCeiling ?? 0;
            pendingExceptionCeiling = newExceptionCeiling ?? 0;
            pendingPalletCeiling = newPalletCeiling ?? 0;
            pendingPalletExceptionCeiling = newPalletExceptionCeiling ?? 0;
            pendingProductLabelCeiling = newLabelCeiling ?? 0;
            await savePersistedCeiling(deps.exec, CEILING_META_KEY, pendingCeiling);
            await savePersistedCeiling(deps.exec, BOX_CEILING_META_KEY, pendingBoxCeiling);
            await savePersistedCeiling(
              deps.exec,
              EXCEPTION_CEILING_META_KEY,
              pendingExceptionCeiling,
            );
            await savePersistedCeiling(deps.exec, PALLET_CEILING_META_KEY, pendingPalletCeiling);
            await savePersistedCeiling(
              deps.exec,
              PALLET_EXCEPTION_CEILING_META_KEY,
              pendingPalletExceptionCeiling,
            );
            await savePersistedCeiling(
              deps.exec,
              PRODUCT_LABEL_CEILING_KEY,
              pendingProductLabelCeiling,
            );
            const instId = await ensureInstallId();
            // A batch's box set (when non-empty) is folded into `batchId`
            // (Finding 1) via `boxSetSignature`, on top of `maxId` when items
            // are ALSO present: pinning `pendingCeiling` alone is not enough
            // to protect a box that closes while an ITEM batch is in flight,
            // because `maxId` does not change just because the box set grew,
            // and the server claims batch ids in `sync_batches` and
            // short-circuits an already-claimed one with `alreadyApplied`
            // BEFORE its own box-closures loop (`station-scans.service.ts`) --
            // so a retry that silently balloons its box set under an unchanged
            // key would never have that new closure actually applied
            // server-side, while this device's `ackBoxes` marks it
            // acknowledged anyway. `pendingBoxCeiling` above already stops the
            // SET from growing mid-retry; folding its signature into `batchId`
            // is what also lets the NEXT batch (once this one clears) claim a
            // key of its own, and what already gave the boxes-only branch
            // (`maxId === null`) a distinct key across a print-verification
            // outcome resolving (Task 13 review, second wave) -- see
            // `boxSetSignature`'s own doc comment.
            const boxSuffix = boxes.length > 0 ? `:box:${boxSetSignature(boxes)}` : "";
            const exceptionSuffix =
              newExceptionCeiling !== null ? `:exception:${newExceptionCeiling}` : "";
            // Both pallet channels join the key on exactly the terms the box
            // channels do -- see `palletSetSignature`'s own doc comment for
            // the closure the server would otherwise silently swallow, and
            // `PALLET_EXCEPTION_CEILING_META_KEY` for the exception half.
            const palletSuffix = pallets.length > 0 ? `:pallet:${palletSetSignature(pallets)}` : "";
            const palletExceptionSuffix =
              newPalletExceptionCeiling !== null
                ? `:pallet-exception:${newPalletExceptionCeiling}`
                : "";
            const channelSuffix = `${boxSuffix}${exceptionSuffix}${palletSuffix}${palletExceptionSuffix}`;
            const generatedBatchId =
              labelEvents.length > 0
                ? `product-label:${productLabelValueDigest({ machineId: deps.machineId, instId, maxId, boxSuffix, exceptionSuffix, labels: productLabelSetSignature(labelEvents) })}`
                : maxId !== null
                  ? `${deps.machineId}:${instId}:${maxId}${channelSuffix}`
                  : `${deps.machineId}:${instId}${channelSuffix}`;
            batchId = (await ensurePendingBatchId()) ?? boundedBatchId(generatedBatchId);
            if (pendingBatchId === null) {
              pendingBatchId = batchId;
              await savePersistedValue(deps.exec, BATCH_ID_META_KEY, batchId);
            }
            serialsLeft = await computeSerialsLeft(deps.exec);
            if (labelEvents.length > 0 && owner) {
              if (!labelPin && newLabelCeiling !== null)
                labelPin = await saveProductLabelBatchPin(deps.exec, {
                  credentialOwnership: owner,
                  request: {
                    batchId,
                    items: toPayload(batch),
                    boxes: toBoxPayload(boxes),
                    exceptions: toExceptionPayload(exceptions),
                    productLabelEvents: labelEvents,
                    serialsLeft,
                  },
                  scanCeiling: maxId,
                  boxCeiling: newBoxCeiling,
                  exceptionCeiling: newExceptionCeiling,
                  labelCeiling: newLabelCeiling,
                  boxes: ackBoxRows.map((box) => ({
                    boxId: box.boxId,
                    printVerifiedAt: box.printVerifiedAt,
                    printSkippedAt: box.printSkippedAt,
                  })),
                });
              if (labelPin) {
                batchId = labelPin.request.batchId;
                labelEvents = labelPin.request.productLabelEvents;
                maxId = labelPin.scanCeiling;
                newBoxCeiling = labelPin.boxCeiling;
                newExceptionCeiling = labelPin.exceptionCeiling;
                newLabelCeiling = labelPin.labelCeiling;
                ackBoxRows = labelPin.boxes;
              }
            }
          } finally {
            preparationLease.release();
          }
          if (pauseInvalidated() || credentialGeneration.sealed) break;
          const payload = labelPin?.request ?? {
            batchId,
            items: toPayload(batch),
            boxes: toBoxPayload(boxes),
            exceptions: toExceptionPayload(exceptions),
            pallets: toPalletPayload(pallets),
            palletExceptions: toPalletExceptionPayload(palletExceptions),
            serialsLeft,
          };
          const res = negotiated
            ? await sendStationEvidence({
                exec: deps.exec,
                client: deps.client,
                generation: credentialGeneration,
                key: `scans:${batchId}`,
                path: "/station/grants/v1/evidence/scans",
                batchId,
                payload,
                links: evidenceLinks,
                checkpoint: {
                  scanRows: ackScanRows,
                  maxId,
                  boxCeiling: newBoxCeiling,
                  exceptionCeiling: newExceptionCeiling,
                  palletCeiling: newPalletCeiling,
                  palletExceptionCeiling: newPalletExceptionCeiling,
                  labelCeiling: newLabelCeiling,
                  boxes: ackBoxRows,
                  pallets,
                  labelEvents,
                },
              })
            : await deps.client.post<BatchResponse>("/station/scans", payload);
          // Another engine sharing this key may have received the terminal
          // 401 while this request was in flight. Its response is now stale:
          // do not record conflicts/ranges, ack facts, or clear retry state.
          if (pauseInvalidated() || credentialGeneration.sealed) break;
          if (!isBatchResponse(res)) {
            // Parsed fine but isn't this endpoint's contract — could be a
            // proxy/captive portal on the plant network. Fall into the
            // same failure path as a network error: do not ack.
            throw new Error("station: unexpected /station/scans response shape");
          }
          const labelReceipt =
            labelEvents.length > 0
              ? validateProductLabelReceipt(labelEvents, res.productLabelReceipt)
              : null;
          const commitLease = acquireCredentialCommitLease(credentialGeneration);
          if (!commitLease) break;
          try {
            const commitIsCurrent = () => !pauseInvalidated() && !credentialGeneration.sealed;
            const committedPin = negotiated
              ? await readStationEvidencePin(deps.exec, credentialGeneration, `scans:${batchId}`)
              : null;
            const commitExec = negotiated
              ? await stationEvidenceCommitExecutor(
                  deps.exec,
                  credentialGeneration,
                  committedPin?.credentialOwnership,
                )
              : deps.exec;
            if (!commitIsCurrent()) break drainLoop;
            if (owner && res.validationOccurrences !== undefined) {
              await applyValidationOutcomes(
                commitExec,
                owner,
                parseValidationOutcomes(res.validationOccurrences),
              );
              if (!commitIsCurrent()) break drainLoop;
            }
            // Filtered element-by-element, not all-or-nothing: dropping only
            // the malformed entry (Finding 2) keeps the rest of this batch's
            // conflicts intact. That matters more here than it would somewhere
            // safety-critical — this is a courtesy count, not delivery — and
            // discarding the whole array over one bad element would
            // under-report further than a single malformed field warrants;
            // nothing about one malformed entry says anything about the
            // others in the same response.
            const reported = Array.isArray(res.conflicts)
              ? res.conflicts.filter(isBatchConflict)
              : [];
            if (reported.length > 0) {
              // Recorded BEFORE the ack, on purpose: `recordConflicts` and
              // `ackThrough` are two separate device-side writes (this pool
              // has no multi-call transaction — see the module doc comment),
              // so a crash between them is possible either way. Persisting
              // conflicts first means a crash there simply resends the batch;
              // the server already applied it and answers `alreadyApplied`
              // with an empty `conflicts` list, and the ones already stored
              // locally are untouched (recordConflicts is an idempotent
              // upsert). The other order would lose them: acking first and
              // then crashing before this write deletes the outbox rows that
              // were the only local record a conflict existed for that batch,
              // and the resend that would have carried them again never
              // happens because the server no-ops an already-applied batch.
              //
              // Isolated in its own try/catch, separate from the network/shape
              // catch below (Finding 1): a failure here has nothing to do with
              // whether the server received the batch — it already did,
              // durably, before this response ever arrived — so retrying
              // protects nothing and would instead wedge every subsequent scan
              // on this terminal behind a batch that can never ack. The floor
              // rule (design brief 04) is that nothing competes with scan
              // delivery, and a courtesy count is exactly the kind of thing
              // that must not. The accepted trade: a failed recording loses
              // those conflicts on this device permanently — a resend of an
              // already-applied batch reports `conflicts: []` (the server
              // decides conflicts at ingest and never recomputes them for a
              // retry), so there is no second chance on this device. A
              // silently under-reported courtesy count beats a terminal that
              // cannot deliver scans, and the cabinet remains the
              // authoritative record either way.
              try {
                await recordConflicts(commitExec, reported, new Date(now()).toISOString());
                // A still-open box corrects itself: the operator simply scans
                // one more item. A CLOSED box is taped and labelled, so it
                // stays as printed and ends one position short — the cabinet
                // is where that surfaces. This is the same trade the server
                // makes when it marks a box item displaced rather than
                // deleting it. Same try/catch as `recordConflicts` above, for
                // the same reason: this is bookkeeping, not delivery.
                //
                // Once conflict persistence starts, finish this complete
                // idempotent bookkeeping unit before observing a pause. The
                // server's already-applied retry carries no conflicts, so
                // stopping between rows would permanently leave the tail of
                // this persisted set attached to an open box. The epoch check
                // immediately after the unit still prevents any stale ack.
                for (const c of reported) {
                  await commitExec.run(
                    `UPDATE codes_mirror SET box_id = NULL
                         WHERE code_hash = ?
                           AND box_id IN (SELECT box_id FROM boxes_mirror WHERE closed_at IS NULL)`,
                    [c.codeHash],
                  );
                }
              } catch (err) {
                console.error("station: recording conflicts failed", err);
              }
              if (!commitIsCurrent()) break drainLoop;
            }
            // Applied AFTER the validated response and BEFORE the ack, in its
            // own try/catch: a pool top-up that fails must not block delivery,
            // for the same reason a failed conflict recording does not (see
            // above). The device simply runs on what it has; the next
            // response carries another block. Losing one block costs at most
            // some burnt numbers, and SSCCs need not be contiguous.
            if (res.ssccBlock && isBatchSsccBlock(res.ssccBlock)) {
              if (!commitIsCurrent()) break drainLoop;
              try {
                await addRange(commitExec, res.ssccBlock);
              } catch (err) {
                console.error("station: applying serial block failed", err);
              }
              if (!commitIsCurrent()) break drainLoop;
            }
            const denied = Array.isArray(res.denied)
              ? res.denied.filter(isDeniedStationRecord)
              : [];
            if (denied.length > 0) {
              if (!commitIsCurrent()) break drainLoop;
              try {
                await savePersistedValue(
                  commitExec,
                  RECOVERY_DENIED_META_KEY,
                  JSON.stringify({ batchId, denied }),
                );
                console.warn(
                  `station: ${denied.length} sync ${denied.length === 1 ? "record" : "records"} quarantined by server`,
                );
              } catch (err) {
                // The authoritative quarantine is server-side. A damaged local
                // metadata table must not wedge every later production scan.
                console.error("station: preserving recovery denials failed", err);
              }
              if (!commitIsCurrent()) break drainLoop;
            }
            // `alreadyApplied` is a success: this exact batch is on the
            // server already, so holding on to it would wedge the queue
            // forever.
            if (maxId !== null) {
              if (!commitIsCurrent()) break drainLoop;
              if (negotiated) {
                // A receipt proves only the original bytes. A changed row remains
                // recoverable even if its id is below this batch's old ceiling.
                for (const row of ackScanRows) {
                  await commitExec.run(
                    `DELETE FROM outbox WHERE id=? AND shift_id IS ? AND terminal_id IS ? AND raw IS ? AND verdict IS ? AND scanned_at IS ? AND code_hash IS ? AND gtin14 IS ? AND serial IS ? AND box_id IS ? AND operator_id IS ?`,
                    [
                      row.id,
                      row.shiftId,
                      row.terminalId,
                      row.raw,
                      row.verdict,
                      row.scannedAt,
                      row.code?.codeHash ?? null,
                      row.code?.gtin14 ?? null,
                      row.code?.serial ?? null,
                      row.boxId,
                      row.operatorId,
                    ],
                  );
                  if ((await commitExec.all("SELECT 1 FROM outbox WHERE id=?", [row.id])).length)
                    throw new StationEvidenceRecoveryError(
                      "station evidence queue identity changed",
                    );
                }
              } else await ackThrough(commitExec, maxId);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (ackBoxRows.length > 0) {
              // `boxes` itself -- not just the ids -- so the ack can gate each
              // row on the outcome fields actually read into THIS payload
              // (Finding 6): see `ackBoxes`'s own doc comment.
              if (!commitIsCurrent()) break drainLoop;
              await ackBoxes(commitExec, ackBoxRows, new Date(now()).toISOString());
              if (!commitIsCurrent()) break drainLoop;
            }
            if (newExceptionCeiling !== null) {
              if (!commitIsCurrent()) break drainLoop;
              await ackExceptionsThrough(commitExec, newExceptionCeiling);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pallets.length > 0) {
              // `pallets` itself -- not just the ids -- so each row's ack is
              // gated on the print-verification fields actually read into THIS
              // payload; see `ackPallets`'s own doc comment.
              if (!commitIsCurrent()) break drainLoop;
              await ackPallets(commitExec, pallets, new Date(now()).toISOString());
              if (!commitIsCurrent()) break drainLoop;
            }
            if (newPalletExceptionCeiling !== null) {
              if (!commitIsCurrent()) break drainLoop;
              await ackPalletExceptionsThrough(commitExec, newPalletExceptionCeiling);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (labelReceipt && owner) {
              await ackProductLabelEvents(commitExec, owner, labelEvents, labelReceipt);
              if (!commitIsCurrent()) break drainLoop;
            }
            // Clear the identity first, then its ceilings. A crash in between
            // leaves stale ceilings that exclude newer rows and are safely
            // discarded by the empty-prefix branch above. The reverse order
            // could expose newer rows under an already-applied batch id.
            if (!commitIsCurrent()) break drainLoop;
            if (labelPin) await clearProductLabelBatchPin(commitExec);
            else await clearPersistedCeiling(commitExec, BATCH_ID_META_KEY);
            if (!commitIsCurrent()) break drainLoop;
            pendingBatchId = null;
            if (pendingCeiling !== null) {
              await clearPersistedCeiling(commitExec, CEILING_META_KEY);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pendingBoxCeiling !== null) {
              await clearPersistedCeiling(commitExec, BOX_CEILING_META_KEY);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pendingExceptionCeiling !== null) {
              await clearPersistedCeiling(commitExec, EXCEPTION_CEILING_META_KEY);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pendingPalletCeiling !== null) {
              await clearPersistedCeiling(commitExec, PALLET_CEILING_META_KEY);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pendingPalletExceptionCeiling !== null) {
              await clearPersistedCeiling(commitExec, PALLET_EXCEPTION_CEILING_META_KEY);
              if (!commitIsCurrent()) break drainLoop;
            }
            if (pendingProductLabelCeiling !== null)
              await clearPersistedCeiling(commitExec, PRODUCT_LABEL_CEILING_KEY);
            pendingCeiling = null;
            pendingBoxCeiling = null;
            pendingExceptionCeiling = null;
            pendingPalletCeiling = null;
            pendingPalletExceptionCeiling = null;
            pendingProductLabelCeiling = null;
            if (owner && commitIsCurrent()) {
              try {
                await purgeCompletedProductLabelJobs(commitExec, owner);
              } catch {
                console.warn("station: delivered print copies retained after cleanup failure");
              }
            }
            evidenceNeedsRecovery = false;
            lastSuccessAt = now();
            backoffMs = BACKOFF_START_MS;
          } finally {
            commitLease.release();
          }
        } catch (err) {
          if (err instanceof StationEvidenceRecoveryError) evidenceNeedsRecovery = true;
          if (isStationCredentialRejection(err)) {
            await rejectCredential();
            break;
          }
          if (pauseInvalidated()) break;
          if (credentialGeneration.sealed) break;
          // Every non-credential failure here — network error, timeout,
          // non-401 response, bad JSON, or wrong shape — is retried
          // indefinitely. A real authenticated 401 is the one terminal
          // exception handled above: retrying a rejected key can never heal,
          // so the queue is sealed for same-device re-pair instead. No batch
          // is quarantined or dropped on either path.
          if (labelEvents.length > 0) console.error("station: product label sync batch failed");
          else console.error("station: sync batch failed", err);
          scheduleRetry();
          break;
        }
      }
      if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
        try {
          await reconcileReviewedConflicts(deps.exec, deps.client);
        } catch (err) {
          if (isStationCredentialRejection(err)) await rejectCredential();
          else console.error("station: conflict status reconciliation failed", err);
        }
      }
      if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
        try {
          await reconcileReleasedCodes(deps.exec, deps.client);
        } catch (err) {
          if (isStationCredentialRejection(err)) await rejectCredential();
          else console.error("station: code release reconciliation failed", err);
        }
      }
      if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
        try {
          const lease = acquireCredentialCommitLease(credentialGeneration);
          if (lease) {
            try {
              const owner = await productLabelOwnership;
              if (owner)
                await reconcileValidationOccurrences(
                  deps.exec,
                  deps.client,
                  owner,
                  () => !pauseInvalidated() && !credentialGeneration.sealed,
                );
            } finally {
              lease.release();
            }
          }
        } catch (err) {
          // Sealing must run after releasing our own lease, otherwise it waits on itself.
          if (isStationCredentialRejection(err)) await rejectCredential();
          else console.warn("station: validation occurrence confirmation pending");
        }
      }
      if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
        try {
          const owner = await productLabelOwnership;
          if (!owner) {
            // Legacy/mock engines have no credential owner to fence a repair.
            // The paired production path always carries one.
          } else {
            // This pass runs inside the same single-flight drain as scan acks.
            // Replayed rows are queued only after the existing batch has retired.
            const facts = await readBoxReconciliationBatch(
              deps.exec,
              undefined,
              200,
              new Date(now() - 120_000).toISOString(),
            );
            if (facts.length > 0 && !pauseInvalidated() && !credentialGeneration.sealed) {
              const raw = await deps.client.post("/station/boxes/reconciliation", {
                boxes: facts.map(
                  ({
                    codeHashes: _codeHashes,
                    revision: _revision,
                    controlAfterReplay: _controlAfterReplay,
                    ...wire
                  }) => wire,
                ),
              });
              const response = boxReconciliationResponseSchema.parse(raw);
              if (!pauseInvalidated() && !credentialGeneration.sealed) {
                const lease = acquireCredentialCommitLease(credentialGeneration);
                if (lease) {
                  try {
                    // A real paired station has an ownership digest. Without it,
                    // a response cannot acquire the SQLite generation fence.
                    if (owner && !pauseInvalidated() && !credentialGeneration.sealed) {
                      const writer = await stationEvidenceCommitExecutor(
                        deps.exec,
                        credentialGeneration,
                        owner,
                      );
                      await applyBoxReconciliationResults(writer, facts, response.results);
                      if (response.results.some((result) => result.status === "replay_required"))
                        requested = true;
                      else if (facts.length === 200) requested = true;
                    }
                  } finally {
                    lease.release();
                  }
                }
              }
            }
          }
        } catch (err) {
          if (isStationCredentialRejection(err)) await rejectCredential();
          else {
            console.warn("station: box reconciliation pending", err);
            scheduleRetry();
          }
        }
      }
      if (!pauseInvalidated() && !credentialGeneration.sealed && retryTimer === null) {
        try {
          // Display-only: a failure keeps the last answer and never schedules
          // a retry or marks the queue stuck.
          await shiftProgress.refresh(() => !pauseInvalidated() && !credentialGeneration.sealed);
        } catch (err) {
          if (isStationCredentialRejection(err)) await rejectCredential();
          else console.warn("station: shift progress unavailable");
        }
      }
    } catch (err) {
      if (err instanceof StationEvidenceRecoveryError) evidenceNeedsRecovery = true;
      // readBatch can fail (e.g. device DB is locked or corrupt). ackThrough
      // failures are handled by the inner catch above and are safe: the batch
      // was already accepted, so the next drain resends the exact same
      // (ceiling-pinned) batch id and the server no-ops it. This catch
      // handles readBatch errors
      // and other device-database errors that must not escape as unhandled
      // rejections — every call site launches the drain with a discarded
      // promise, so an uncaught rejection would silently kill sync with the
      // indicator frozen at its last value.
      console.error("station: sync drain failed", err);
      if (!credentialGeneration.sealed) scheduleRetry();
      try {
        await publishState();
      } catch (publishErr) {
        console.error("station: sync state publish failed", publishErr);
      }
    } finally {
      // Post-drain state publish. If it fails, do not retry the drain — all
      // batches that were ready to send have been sent or have exhausted retry.
      // A stale state report is benign; a false retry triggered by this publish
      // failure would not be.
      try {
        await publishState();
      } catch (publishErr) {
        console.error("station: sync state publish failed", publishErr);
      }

      draining = false;
      // Only continue immediately when nothing scheduled a retry during this
      // drain. If the last attempt failed, `retryTimer` is already set (by
      // `scheduleRetry` above) by the time this runs — continuing anyway
      // here would be exactly the backoff bypass `nudge()` also guards
      // against, just reached from the opposite direction (a nudge that
      // arrived WHILE this drain was running, rather than one that arrives
      // after it). Dropping a stale `requested` in that case is safe: the
      // scheduled retry performs a full drain of whatever is queued by the
      // time it fires, so no request is actually lost, only its timing.
      const shouldContinue =
        requested && !stopped && !paused && !credentialGeneration.sealed && retryTimer === null;
      requested = false;
      if (shouldContinue) {
        void drain();
      } else {
        settleIdle();
      }
    }
  }

  function scheduleRetry(): void {
    if (stopped || paused || credentialGeneration.sealed || retryTimer !== null) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void drain();
    }, delay);
  }

  function pause(): void {
    pauseEpoch += 1;
    paused = true;
    requested = false;
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function idle(): Promise<void> {
    if (!draining) return Promise.resolve();
    return new Promise<void>((resolve) => idleResolvers.push(resolve));
  }

  return {
    nudge() {
      if (stopped || paused || credentialGeneration.sealed) return;
      if (draining) {
        requested = true;
        return;
      }
      // A retry is already scheduled: let the backoff run its course
      // instead of hammering the server with one attempt per nudge (a scan,
      // the `online` listener, the heartbeat) while the link is down. The
      // scheduled attempt drains whatever is queued by the time it fires, so
      // nothing queued now is lost — only sent later than this particular
      // nudge asked for.
      if (retryTimer !== null) return;
      void drain();
    },
    pause,
    pauseAndWaitForIdle() {
      pause();
      return idle();
    },
    resume() {
      if (stopped || credentialGeneration.sealed || !paused) return;
      paused = false;
      if (draining) {
        requested = true;
        return;
      }
      void drain();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    },
    idle,
    async requestFullShiftAudit(shiftId) {
      if (stopped || credentialGeneration.sealed) return;
      const lease = acquireCredentialCommitLease(credentialGeneration);
      if (!lease) return;
      try {
        const owner = await productLabelOwnership;
        if (!owner || credentialGeneration.sealed) return;
        const writer = await stationEvidenceCommitExecutor(deps.exec, credentialGeneration, owner);
        await requestFullShiftReconciliation(writer, shiftId);
      } finally {
        lease.release();
      }
      this.nudge();
    },
    async reconcileNow() {
      this.nudge();
      await idle();
    },
    watchShiftProgress(shiftId) {
      shiftProgress.watch(shiftId);
      watchGeneration += 1;
      publishWatchedProgress(watchGeneration).catch((publishErr: unknown) => {
        console.error("station: sync state publish failed", publishErr);
      });
    },
  };
}
