import {
  buildSscc,
  canonicalizeKm,
  classifyInventoryScan,
  inventoryEventSchema,
  kmHash,
  parseScannedSscc,
  type InventoryEvent,
  type InventoryRepackMutation,
  type InventoryScanSnapshotRow,
} from "@markiro/domain";

import type { SqlExecutor } from "./mirror.js";
import { setInventoryProductionDate } from "./inventory-date.js";
import { burnSerial } from "./sscc-pool.js";

const BOX_EXTENSION_DIGIT = 0;

export interface RecordInventoryRepackScanInput {
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  operatorId: string;
  taskGtin14: string;
  issuerPrefix: string;
  capacity: number;
  raw: string;
  eventId: string;
  scannedAt: string;
  createBoxId?: () => string;
  createItemId?: () => string;
  /** Оператор осознанно зачёл код с текущей датой короба. */
  acceptSourceDateMismatch?: boolean;
}

export interface InventoryRepackBoxView {
  boxId: string;
  oldSsccContext: string;
  newSscc: string;
  productionDate: string;
  capacity: number;
  itemCount: number;
  lastItemId: string | null;
  state: "open" | "closed" | "invalidated";
  printState: "not_ready" | "pending" | "printing" | "printed" | "failed";
  printErrorCode: string | null;
  invalidationSource: "claim_lost" | "admin" | null;
  ownerDeviceId: string;
}

export interface InventoryRepackStateView {
  phase: "awaiting-old-box" | "scanning" | "closed-pending-print" | "invalidated";
  box: InventoryRepackBoxView | null;
}

export interface InventoryRepackScanResult {
  verdict:
    | "old-box-selected"
    | "expected"
    | "protected"
    | "known-ineligible"
    | "unknown"
    | "duplicate"
    | "invalid"
    | "date-mismatch"
    | "source-date-mismatch"
    | "capacity-closed";
  boxId: string | null;
  newSscc: string | null;
  itemCount: number;
  printState: InventoryRepackBoxView["printState"] | null;
  sourceParentMismatch: boolean;
  /** Дата из снапшота для спорного кода; null во всех остальных вердиктах. */
  sourceProductionDate: string | null;
}

interface TerminalRow {
  active_production_date: string | null;
  open_repack_box_id: string | null;
  next_device_sequence: number;
}

interface BoxRow {
  box_id: string;
  old_sscc_context: string;
  new_sscc: string;
  owner_device_id: string;
  capacity: number;
  production_date: string;
  state: "open" | "closed" | "invalidated";
  print_state: InventoryRepackBoxView["printState"];
  print_error_code: string | null;
  invalidation_source: InventoryRepackBoxView["invalidationSource"];
  item_count: number;
  last_item_id: string | null;
}

interface SnapshotRow {
  code_hash: string;
  canonical_raw: string;
  gtin14: string;
  serial: string;
  source_status: InventoryScanSnapshotRow["sourceStatus"];
  source_state: string | null;
  source_production_date: string | null;
  expected: number;
  protected: number;
  parent_sscc: string | null;
}

interface JournalRow {
  payload_json: string;
}

const serializeKey = new Map<string, Promise<void>>();

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = serializeKey.get(key) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  serializeKey.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function terminal(
  exec: SqlExecutor,
  input: Pick<RecordInventoryRepackScanInput, "inventoryId" | "snapshotId" | "deviceId">,
): Promise<TerminalRow> {
  const rows = await exec.all<TerminalRow>(
    `SELECT active_production_date, open_repack_box_id, next_device_sequence
       FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [input.inventoryId, input.snapshotId, input.deviceId],
  );
  const row = rows[0];
  if (!row?.active_production_date) throw new Error("inventory repack terminal date is missing");
  return row;
}

async function ownedBox(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  deviceId: string,
  boxId: string,
): Promise<BoxRow | null> {
  const rows = await exec.all<BoxRow>(
    `SELECT box.box_id, box.old_sscc_context, box.new_sscc, box.owner_device_id,
            box.capacity, box.production_date, box.state, box.print_state, box.print_error_code,
            box.invalidation_source,
            (SELECT COUNT(*) FROM inventory_repack_items_mirror item
              WHERE item.inventory_id = box.inventory_id AND item.snapshot_id = box.snapshot_id
                AND item.box_id = box.box_id AND item.removed_at IS NULL) AS item_count,
            (SELECT item.item_id FROM inventory_repack_items_mirror item
              WHERE item.inventory_id = box.inventory_id AND item.snapshot_id = box.snapshot_id
                AND item.box_id = box.box_id AND item.removed_at IS NULL
              ORDER BY item.position DESC LIMIT 1) AS last_item_id
       FROM inventory_repack_boxes_mirror box
      WHERE box.inventory_id = ? AND box.snapshot_id = ? AND box.owner_device_id = ?
        AND box.box_id = ?
      LIMIT 1`,
    [inventoryId, snapshotId, deviceId, boxId],
  );
  return rows[0] ?? null;
}

function view(row: BoxRow): InventoryRepackBoxView {
  return {
    boxId: row.box_id,
    oldSsccContext: row.old_sscc_context,
    newSscc: row.new_sscc,
    productionDate: row.production_date,
    capacity: row.capacity,
    itemCount: row.item_count,
    lastItemId: row.last_item_id,
    state: row.state,
    printState: row.print_state,
    printErrorCode: row.print_error_code,
    invalidationSource: row.invalidation_source,
    ownerDeviceId: row.owner_device_id,
  };
}

export async function readInventoryRepackState(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  deviceId: string,
): Promise<InventoryRepackStateView> {
  const terminalRows = await exec.all<{ open_repack_box_id: string | null }>(
    `SELECT open_repack_box_id FROM inventory_terminal_state
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?`,
    [inventoryId, snapshotId, deviceId],
  );
  const openBoxId = terminalRows[0]?.open_repack_box_id;
  if (!openBoxId) return { phase: "awaiting-old-box", box: null };
  const box = await ownedBox(exec, inventoryId, snapshotId, deviceId, openBoxId);
  if (!box) return { phase: "awaiting-old-box", box: null };
  return {
    phase:
      box.state === "invalidated"
        ? "invalidated"
        : box.state === "closed" && box.print_state !== "printed"
          ? "closed-pending-print"
          : "scanning",
    box: view(box),
  };
}

async function existingJournal(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  eventId: string,
): Promise<JournalRow | null> {
  const rows = await exec.all<JournalRow>(
    `SELECT payload_json FROM inventory_repack_journal
      WHERE inventory_id = ? AND snapshot_id = ? AND event_id = ?`,
    [inventoryId, snapshotId, eventId],
  );
  return rows[0] ?? null;
}

async function allocateSequence(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  deviceId: string,
): Promise<number> {
  const rows = await exec.all<{ sequence: number }>(
    `UPDATE inventory_terminal_state SET next_device_sequence = next_device_sequence + 1
      WHERE inventory_id = ? AND snapshot_id = ? AND device_id = ?
      RETURNING next_device_sequence - 1 AS sequence`,
    [inventoryId, snapshotId, deviceId],
  );
  const sequence = rows[0]?.sequence;
  if (!sequence) throw new Error("inventory repack sequence allocation failed");
  return sequence;
}

function parseStoredEvent(row: JournalRow): InventoryEvent {
  let value: unknown;
  try {
    value = JSON.parse(row.payload_json);
  } catch {
    throw new Error("inventory repack journal payload is invalid");
  }
  const parsed = inventoryEventSchema.safeParse(value);
  if (!parsed.success) throw new Error("inventory repack journal payload is invalid");
  return parsed.data;
}

interface JournalWriteInput {
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  event: InventoryEvent;
  action: string;
  boxId: string;
  itemId?: string | null;
  oldSscc?: string | null;
  newSscc?: string | null;
  capacity?: number | null;
  productionDate?: string | null;
  position?: number | null;
  closeBox?: boolean;
  sourceParentMismatch?: boolean;
}

async function writeJournal(exec: SqlExecutor, input: JournalWriteInput): Promise<void> {
  const event = input.event;
  const existing = await existingJournal(exec, input.inventoryId, input.snapshotId, event.eventId);
  if (existing) {
    if (existing.payload_json !== JSON.stringify(event)) {
      throw new Error("inventory repack event identity changed");
    }
    return;
  }
  await exec.run(
    `INSERT INTO inventory_repack_journal
       (inventory_id, snapshot_id, event_id, device_id, device_sequence, operator_id,
        occurred_at, event_kind, normalized_identity, code_hash, canonical_raw,
        active_production_date, local_verdict, action, box_id, item_id, old_sscc,
        new_sscc, capacity, production_date, position, close_box,
        source_parent_mismatch, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.inventoryId,
      input.snapshotId,
      event.eventId,
      input.deviceId,
      event.deviceSequence,
      event.operatorId,
      event.scannedAt,
      event.kind,
      event.normalizedIdentity,
      event.codeHash,
      event.canonicalRaw,
      event.activeProductionDate,
      event.localVerdict,
      input.action,
      input.boxId,
      input.itemId ?? null,
      input.oldSscc ?? null,
      input.newSscc ?? null,
      input.capacity ?? null,
      input.productionDate ?? null,
      input.position ?? null,
      input.closeBox ? 1 : 0,
      input.sourceParentMismatch ? 1 : 0,
      JSON.stringify(event),
    ],
  );
  const stored = await existingJournal(exec, input.inventoryId, input.snapshotId, event.eventId);
  if (!stored || stored.payload_json !== JSON.stringify(event)) {
    throw new Error("inventory repack journal persistence failed");
  }
}

async function replayResult(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
  stored: JournalRow,
): Promise<InventoryRepackScanResult> {
  const event = parseStoredEvent(stored);
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  const box = state.box;
  const verdict =
    event.repack?.action === "open-box"
      ? "old-box-selected"
      : event.repack?.action === "add-item" && event.repack.closeBox
        ? "capacity-closed"
        : event.localVerdict === "repack-action"
          ? "expected"
          : event.localVerdict;
  return {
    verdict,
    boxId: box?.boxId ?? null,
    newSscc: box?.newSscc ?? null,
    itemCount: box?.itemCount ?? 0,
    printState: box?.printState ?? null,
    sourceParentMismatch: false,
    sourceProductionDate: null,
  };
}

async function snapshotFacts(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
  codeHash: string,
): Promise<{ row: InventoryScanSnapshotRow | null; duplicate: boolean; reattachAllowed: boolean }> {
  const rows = await exec.all<SnapshotRow>(
    `SELECT code_hash, canonical_raw, gtin14, serial, source_status, source_state,
            source_production_date, expected, protected, parent_sscc
       FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id = ? AND code_hash = ?`,
    [input.snapshotId, codeHash],
  );
  const claims = await exec.all<{ code_hash: string; winning_device_id: string }>(
    `SELECT code_hash, winning_device_id FROM inventory_code_results_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ?`,
    [input.inventoryId, input.snapshotId, codeHash],
  );
  const row = rows[0];
  return {
    row: row
      ? {
          codeHash: row.code_hash,
          canonicalRaw: row.canonical_raw,
          gtin14: row.gtin14,
          serial: row.serial,
          sourceStatus: row.source_status,
          sourceState: row.source_state,
          sourceProductionDate: row.source_production_date,
          expected: row.expected === 1,
          protected: row.protected === 1,
          parentSscc: row.parent_sscc,
        }
      : null,
    duplicate: claims.length > 0,
    reattachAllowed:
      claims[0]?.winning_device_id === input.deviceId &&
      rows[0]?.expected === 1 &&
      rows[0]?.protected !== 1 &&
      (
        await exec.all<{ count: number }>(
          `SELECT COUNT(*) AS count FROM inventory_repack_items_mirror
            WHERE inventory_id = ? AND snapshot_id = ? AND code_hash = ? AND removed_at IS NULL`,
          [input.inventoryId, input.snapshotId, codeHash],
        )
      )[0]?.count === 0,
  };
}

/**
 * Единственная непустая дата среди пригодного (expected, не protected)
 * содержимого старого короба. Строки без даты (`source_production_date IS
 * NULL`) не попадают в выборку и не мешают: короб с одной датированной
 * бутылкой и девятнадцатью без даты всё равно даст эту одну дату. Возвращает
 * null, если пригодных датированных строк нет или встречается больше одной
 * разной даты.
 *
 * В отличие от `resolveInventoryScanSourceDate` в
 * `packages/domain/src/inventory/scan.ts`, здесь не исключаются уже зачтённые
 * дети — эта функция читает содержимое **старого** короба целиком, а не то,
 * что ещё предстоит зачесть в новый. На частично переложенном старом коробе
 * (перенесённые бутылки одной датой X, остаток другой Y) это даёт null и
 * открывает новый короб с устаревшей активной датой терминала вместо X —
 * первая же бутылка тогда вызывает диалог расхождения. Осознанный компромисс,
 * поведение не меняется.
 */
async function oldBoxSourceDate(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
  oldSscc: string,
): Promise<string | null> {
  const rows = await exec.all<{ source_production_date: string }>(
    `SELECT DISTINCT source_production_date
       FROM inventory_snapshot_codes_mirror
      WHERE snapshot_id = ? AND parent_sscc = ? AND expected = 1 AND protected = 0
        AND source_production_date IS NOT NULL`,
    [input.snapshotId, oldSscc],
  );
  return rows.length === 1 ? (rows[0]?.source_production_date ?? null) : null;
}

async function recordInternal(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
): Promise<InventoryRepackScanResult> {
  const prior = await existingJournal(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (prior) return replayResult(exec, input, prior);
  const terminalState = await terminal(exec, input);
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  if (state.phase === "closed-pending-print") {
    throw new Error("inventory repack printing is pending");
  }
  if (state.phase === "invalidated") throw new Error("inventory repack box is invalidated");

  if (state.phase === "awaiting-old-box") {
    const oldSscc = parseScannedSscc(input.raw);
    if (!oldSscc) {
      return {
        verdict: "invalid",
        boxId: null,
        newSscc: null,
        itemCount: 0,
        printState: null,
        sourceParentMismatch: false,
        sourceProductionDate: null,
      };
    }
    const seeded = await oldBoxSourceDate(exec, input, oldSscc);
    const boxDate = seeded ?? terminalState.active_production_date!;
    if (seeded !== null && seeded !== terminalState.active_production_date) {
      // Not range-checked against [productionDateFrom, productionDateTo]
      // here: `seeded` only ever comes from `expected = 1` rows, and
      // inventory-mirror.ts's bundle validation (classifyInventorySnapshotRow
      // against the manifest's range) already guarantees those are in range.
      // SqlExecutor exposes only run/all — no transactions — so this UPDATE to
      // inventory_terminal_state commits independently of the open-box journal
      // INSERT a few lines below. If burnSerial then returns null (SSCC pool
      // exhausted) or the journal write fails, the terminal's active date has
      // already moved with no box and no event to show for it; a later
      // old-box scan with mixed contents would fall back to this now-stranded
      // date. Seeding first is still the lesser evil: seeding *after* the
      // journal write would leave the box's own date briefly disagreeing with
      // the terminal's, and every item scan in that window silently degrades
      // to observe-only (see `dateMatches` below) instead of failing loudly.
      await setInventoryProductionDate(exec, {
        inventoryId: input.inventoryId,
        snapshotId: input.snapshotId,
        deviceId: input.deviceId,
        operatorId: input.operatorId,
        productionDate: seeded,
        updatedAt: input.scannedAt,
      });
    }
    const serial = await burnSerial(exec, input.issuerPrefix, BOX_EXTENSION_DIGIT);
    if (serial === null) throw new Error("inventory repack SSCC pool is exhausted");
    const newSscc = buildSscc(BOX_EXTENSION_DIGIT, input.issuerPrefix, serial);
    const boxId = input.createBoxId?.() ?? crypto.randomUUID();
    const sequence = await allocateSequence(
      exec,
      input.inventoryId,
      input.snapshotId,
      input.deviceId,
    );
    const repack: InventoryRepackMutation = {
      action: "open-box",
      boxId,
      oldSscc,
      newSscc,
      capacity: input.capacity,
      productionDate: boxDate,
    };
    const event = inventoryEventSchema.parse({
      eventId: input.eventId,
      deviceSequence: sequence,
      operatorId: input.operatorId,
      scannedAt: input.scannedAt,
      kind: "old_box",
      normalizedIdentity: `old_box:${oldSscc}`,
      codeHash: null,
      canonicalRaw: oldSscc,
      activeProductionDate: boxDate,
      localVerdict: "unknown",
      repack,
    });
    await writeJournal(exec, {
      inventoryId: input.inventoryId,
      snapshotId: input.snapshotId,
      deviceId: input.deviceId,
      event,
      action: "open-box",
      boxId,
      oldSscc,
      newSscc,
      capacity: input.capacity,
      productionDate: boxDate,
    });
    return replayResult(exec, input, { payload_json: JSON.stringify(event) });
  }

  const box = state.box;
  if (!box || box.ownerDeviceId !== input.deviceId) {
    throw new Error("inventory repack box belongs to another terminal");
  }
  let canonical;
  try {
    canonical = canonicalizeKm(input.raw);
  } catch {
    return {
      verdict: "invalid",
      boxId: box.boxId,
      newSscc: box.newSscc,
      itemCount: box.itemCount,
      printState: box.printState,
      sourceParentMismatch: false,
      sourceProductionDate: null,
    };
  }
  const codeHash = kmHash(canonical);
  const facts = await snapshotFacts(exec, input, codeHash);
  const classification = classifyInventoryScan(input.raw, {
    taskGtin14: input.taskGtin14,
    findSnapshotCode: () => facts.row,
    findSnapshotChildren: () => [],
    findLocalClaim: () =>
      facts.duplicate
        ? { codeHash, eventId: "local", deviceId: input.deviceId, scannedAt: input.scannedAt }
        : null,
  });
  if (classification.kind === "invalid" || classification.scanKind !== "item") {
    return {
      verdict: "invalid",
      boxId: box.boxId,
      newSscc: box.newSscc,
      itemCount: box.itemCount,
      printState: box.printState,
      sourceParentMismatch: false,
      sourceProductionDate: null,
    };
  }
  const sourceDate = facts.row?.sourceProductionDate ?? null;
  // Computed once and reused for both the date guard below and the add-item
  // eligibility further down, so the two always agree. A code re-scanned
  // after remove-last/clear-box classifies as "duplicate" with
  // reattachAllowed === true, not "expected" — gating the guard on
  // `classification.kind === "expected"` alone let that re-attach path add
  // the item straight into a box with a different printed date, no dialog.
  const eligible = classification.kind === "expected" || facts.reattachAllowed;
  if (
    !input.acceptSourceDateMismatch &&
    eligible &&
    sourceDate !== null &&
    sourceDate !== box.productionDate
  ) {
    return {
      verdict: "source-date-mismatch",
      boxId: box.boxId,
      newSscc: box.newSscc,
      itemCount: box.itemCount,
      printState: box.printState,
      sourceParentMismatch: false,
      sourceProductionDate: sourceDate,
    };
  }
  const sequence = await allocateSequence(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  const dateMatches = terminalState.active_production_date === box.productionDate;
  const sourceParentMismatch = facts.row?.parentSscc !== box.oldSsccContext;
  const position = box.itemCount + 1;
  const closeBox = eligible && dateMatches && position === box.capacity;
  const itemId = input.createItemId?.() ?? crypto.randomUUID();
  const repack: InventoryRepackMutation | undefined =
    eligible && dateMatches
      ? { action: "add-item", boxId: box.boxId, itemId, position, closeBox }
      : undefined;
  const event = inventoryEventSchema.parse({
    eventId: input.eventId,
    deviceSequence: sequence,
    operatorId: input.operatorId,
    scannedAt: input.scannedAt,
    kind: "item",
    normalizedIdentity: `item:${codeHash}`,
    codeHash,
    canonicalRaw: canonical.raw,
    activeProductionDate: terminalState.active_production_date,
    localVerdict: classification.kind,
    ...(repack ? { repack } : {}),
  });
  await writeJournal(exec, {
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    deviceId: input.deviceId,
    event,
    action: repack ? "add-item" : "observe-only",
    boxId: box.boxId,
    itemId: repack ? itemId : null,
    productionDate: box.productionDate,
    position: repack ? position : null,
    closeBox,
    sourceParentMismatch,
  });
  const after = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  return {
    verdict:
      !dateMatches && eligible
        ? "date-mismatch"
        : closeBox
          ? "capacity-closed"
          : classification.kind,
    boxId: box.boxId,
    newSscc: box.newSscc,
    itemCount: after.box?.itemCount ?? box.itemCount,
    printState: after.box?.printState ?? box.printState,
    sourceParentMismatch,
    sourceProductionDate: null,
  };
}

export function recordInventoryRepackScan(
  exec: SqlExecutor,
  input: RecordInventoryRepackScanInput,
): Promise<InventoryRepackScanResult> {
  return serialized(`${input.inventoryId}:${input.snapshotId}:${input.deviceId}`, () =>
    recordInternal(exec, input),
  );
}

interface CorrectionInput {
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  operatorId: string;
  eventId: string;
  changedAt: string;
}

export interface ResolveInvalidatedInventoryRepackBoxInput extends CorrectionInput {
  reason: "claim-lost";
}

async function correction(
  exec: SqlExecutor,
  input: CorrectionInput,
  action: "remove-last" | "clear-box" | "close-incomplete" | "change-date",
  itemId?: string,
  productionDate?: string,
): Promise<void> {
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  if (state.phase !== "scanning" || !state.box) throw new Error("inventory repack box is not open");
  if (state.box.ownerDeviceId !== input.deviceId) {
    throw new Error("inventory repack box belongs to another terminal");
  }
  if (action === "change-date" && state.box.itemCount > 0) {
    throw new Error("inventory repack non-empty box date is frozen");
  }
  const sequence = await allocateSequence(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  const repack: InventoryRepackMutation =
    action === "remove-last"
      ? { action, boxId: state.box.boxId, itemId: itemId!, changedAt: input.changedAt }
      : action === "change-date"
        ? {
            action,
            boxId: state.box.boxId,
            productionDate: productionDate!,
            changedAt: input.changedAt,
          }
        : { action, boxId: state.box.boxId, changedAt: input.changedAt };
  const event = inventoryEventSchema.parse({
    eventId: input.eventId,
    deviceSequence: sequence,
    operatorId: input.operatorId,
    scannedAt: input.changedAt,
    kind: "repack_action",
    normalizedIdentity: `repack_action:${action}:${state.box.boxId}`,
    codeHash: null,
    canonicalRaw: null,
    activeProductionDate: productionDate ?? state.box.productionDate,
    localVerdict: "repack-action",
    repack,
  });
  await writeJournal(exec, {
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    deviceId: input.deviceId,
    event,
    action,
    boxId: state.box.boxId,
    itemId: itemId ?? null,
    productionDate: productionDate ?? null,
  });
}

export async function removeLastInventoryRepackItem(
  exec: SqlExecutor,
  input: CorrectionInput,
): Promise<void> {
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  if (!state.box || state.box.itemCount === 0) throw new Error("inventory repack box is empty");
  const rows = await exec.all<{ item_id: string }>(
    `SELECT item_id FROM inventory_repack_items_mirror
      WHERE inventory_id = ? AND snapshot_id = ? AND box_id = ? AND removed_at IS NULL
      ORDER BY position DESC LIMIT 1`,
    [input.inventoryId, input.snapshotId, state.box.boxId],
  );
  const itemId = rows[0]?.item_id;
  if (!itemId) throw new Error("inventory repack last item is missing");
  await correction(exec, input, "remove-last", itemId);
}

export function clearOpenInventoryRepackBox(
  exec: SqlExecutor,
  input: CorrectionInput,
): Promise<void> {
  return correction(exec, input, "clear-box");
}

export async function closeIncompleteInventoryRepackBox(
  exec: SqlExecutor,
  input: CorrectionInput & { confirmed: boolean },
): Promise<void> {
  if (!input.confirmed) throw new Error("inventory repack incomplete close requires confirmation");
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  if (!state.box || state.box.itemCount === 0) throw new Error("inventory repack box is empty");
  await correction(exec, input, "close-incomplete");
}

export function changeOpenInventoryRepackDate(
  exec: SqlExecutor,
  input: CorrectionInput & { productionDate: string },
): Promise<void> {
  return correction(exec, input, "change-date", undefined, input.productionDate);
}

async function resolveInvalidatedInternal(
  exec: SqlExecutor,
  input: ResolveInvalidatedInventoryRepackBoxInput,
): Promise<void> {
  const prior = await existingJournal(exec, input.inventoryId, input.snapshotId, input.eventId);
  if (prior) {
    const event = parseStoredEvent(prior);
    if (
      event.operatorId !== input.operatorId ||
      event.scannedAt !== input.changedAt ||
      event.repack?.action !== "resolve-conflict" ||
      event.repack.reason !== input.reason
    ) {
      throw new Error("inventory repack event identity changed");
    }
    return;
  }
  const state = await readInventoryRepackState(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  if (state.phase !== "invalidated" || !state.box) {
    throw new Error("inventory repack box is not invalidated");
  }
  if (state.box.ownerDeviceId !== input.deviceId) {
    throw new Error("inventory repack box belongs to another terminal");
  }
  if (state.box.invalidationSource !== "claim_lost") {
    throw new Error("inventory repack box is not a claim-lost conflict");
  }
  const sequence = await allocateSequence(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  const repack: InventoryRepackMutation = {
    action: "resolve-conflict",
    boxId: state.box.boxId,
    reason: input.reason,
    changedAt: input.changedAt,
  };
  const event = inventoryEventSchema.parse({
    eventId: input.eventId,
    deviceSequence: sequence,
    operatorId: input.operatorId,
    scannedAt: input.changedAt,
    kind: "repack_action",
    normalizedIdentity: `repack_action:resolve-conflict:${state.box.boxId}`,
    codeHash: null,
    canonicalRaw: null,
    activeProductionDate: state.box.productionDate,
    localVerdict: "repack-action",
    repack,
  });
  await writeJournal(exec, {
    inventoryId: input.inventoryId,
    snapshotId: input.snapshotId,
    deviceId: input.deviceId,
    event,
    action: "resolve-conflict",
    boxId: state.box.boxId,
  });
}

export function resolveInvalidatedInventoryRepackBox(
  exec: SqlExecutor,
  input: ResolveInvalidatedInventoryRepackBoxInput,
): Promise<void> {
  return serialized(`${input.inventoryId}:${input.snapshotId}:${input.deviceId}`, () =>
    resolveInvalidatedInternal(exec, input),
  );
}
