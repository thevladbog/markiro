import {
  inventoryEventSchema,
  type InventoryEvent,
  type LabelField,
  type LabelTemplateSpec,
  type RasterizeTextFn,
  type StationInventoryBundleManifest,
} from "@markiro/domain";

import { attemptBoxPrint } from "./box-printing.js";
import {
  inventoryBoxLabelFields,
  renderInventoryBoxLabel,
  type InventoryBoxLabelInput,
} from "./inventory-box-label.js";
import type { PrintTarget } from "./hardware.js";
import type { PrinterLanguage } from "./hardware-config.js";
import type { SqlExecutor } from "./mirror.js";
import { rasterizeText } from "./rasterizer.js";

export type InventoryPrintErrorCode =
  | "template_missing"
  | "printer_unconfigured"
  | "render_failed"
  | "transport_failed"
  | "persistence_failed";

export interface InventoryPrintAttemptView {
  attemptId: string;
  boxId: string;
  kind: "initial" | "reprint";
  attemptNumber: number;
  state: "printing" | "printed" | "failed";
  errorCode: InventoryPrintErrorCode | null;
  attemptedAt: string;
  completedAt: string | null;
  eventId: string | null;
}

export interface InventoryBoxPrintingTransport {
  target: PrintTarget;
  language: PrinterLanguage;
  print: (target: PrintTarget, bytes: Uint8Array) => Promise<void>;
}

export interface AttemptInventoryBoxPrintInput {
  exec: SqlExecutor;
  manifest: StationInventoryBundleManifest & { mode: "repack" };
  inventoryId: string;
  snapshotId: string;
  deviceId: string;
  operatorId: string;
  boxId: string;
  attemptId: string;
  eventId: string;
  attemptedAt: string;
  completedAt: () => string;
  printing: InventoryBoxPrintingTransport | null;
  render?: (
    template: LabelTemplateSpec,
    fields: Record<LabelField, string>,
    language: PrinterLanguage,
  ) => Promise<Uint8Array>;
  rasterizeText?: RasterizeTextFn;
  kind?: "initial" | "reprint";
}

export interface InventoryBoxPrintResult {
  state: "printed" | "failed";
  errorCode: InventoryPrintErrorCode | null;
  sscc: string;
  quantity: number;
  productionDate: string;
  attemptNumber: number;
}

interface BoxFactsRow {
  box_id: string;
  new_sscc: string;
  owner_device_id: string;
  capacity: number;
  production_date: string;
  state: string;
  print_state: string;
  invalidated_at: string | null;
  quantity: number;
  min_date: string | null;
  max_date: string | null;
}

const serializedJobs = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
  const prior = serializedJobs.get(key) ?? Promise.resolve();
  const current = prior.catch(() => undefined).then(job);
  serializedJobs.set(key, current);
  void current
    .finally(() => {
      if (serializedJobs.get(key) === current) serializedJobs.delete(key);
    })
    .catch(() => undefined);
  return current;
}

async function readBoxFacts(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  boxId: string,
): Promise<BoxFactsRow | null> {
  const rows = await exec.all<BoxFactsRow>(
    `SELECT box.box_id, box.new_sscc, box.owner_device_id, box.capacity,
            box.production_date, box.state, box.print_state, box.invalidated_at,
            COUNT(item.item_id) AS quantity,
            MIN(item.production_date) AS min_date, MAX(item.production_date) AS max_date
       FROM inventory_repack_boxes_mirror box
       LEFT JOIN inventory_repack_items_mirror item
         ON item.inventory_id = box.inventory_id AND item.snapshot_id = box.snapshot_id
        AND item.box_id = box.box_id AND item.removed_at IS NULL
      WHERE box.inventory_id = ? AND box.snapshot_id = ? AND box.box_id = ?
      GROUP BY box.inventory_id, box.snapshot_id, box.box_id`,
    [inventoryId, snapshotId, boxId],
  );
  return rows[0] ?? null;
}

function requirePrintable(
  row: BoxFactsRow | null,
  deviceId: string,
  kind: "initial" | "reprint",
): BoxFactsRow {
  const expectedPrintState = kind === "initial" ? ["pending", "failed"] : ["printed"];
  if (
    !row ||
    row.owner_device_id !== deviceId ||
    row.state !== "closed" ||
    row.invalidated_at !== null ||
    !expectedPrintState.includes(row.print_state) ||
    row.quantity <= 0 ||
    row.quantity > row.capacity ||
    row.min_date !== row.production_date ||
    row.max_date !== row.production_date ||
    !/^[0-9]{18}$/.test(row.new_sscc)
  ) {
    throw new Error("inventory box is not printable");
  }
  return row;
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
  if (!sequence) throw new Error("inventory print sequence allocation failed");
  return sequence;
}

async function claimAttempt(
  exec: SqlExecutor,
  input: Pick<
    AttemptInventoryBoxPrintInput,
    "inventoryId" | "snapshotId" | "boxId" | "attemptId" | "attemptedAt"
  > & { kind: "initial" | "reprint" },
): Promise<number> {
  await exec.run(
    `INSERT INTO inventory_repack_print_attempts
       (inventory_id, snapshot_id, attempt_id, box_id, kind, attempt_number, state, attempted_at)
     SELECT ?, ?, ?, ?, ?,
            COALESCE(MAX(attempt_number), 0) + 1, 'printing', ?
       FROM inventory_repack_print_attempts
      WHERE inventory_id = ? AND snapshot_id = ? AND box_id = ?`,
    [
      input.inventoryId,
      input.snapshotId,
      input.attemptId,
      input.boxId,
      input.kind,
      input.attemptedAt,
      input.inventoryId,
      input.snapshotId,
      input.boxId,
    ],
  );
  const [attempt] = await exec.all<{ attempt_number: number }>(
    `SELECT attempt_number FROM inventory_repack_print_attempts
      WHERE inventory_id = ? AND snapshot_id = ? AND attempt_id = ?`,
    [input.inventoryId, input.snapshotId, input.attemptId],
  );
  if (!attempt) throw new Error("inventory print claim failed");
  return attempt.attempt_number;
}

function printMutation(
  kind: "initial" | "reprint",
  boxId: string,
  sscc: string,
  attemptId: string,
  attemptNumber: number,
  result: "printed" | "failed",
  errorCode: InventoryPrintErrorCode | null,
  attemptedAt: string,
  completedAt: string,
) {
  return {
    action: kind === "initial" ? ("print-outcome" as const) : ("reprint-outcome" as const),
    boxId,
    sscc,
    attemptId,
    attemptNumber,
    result,
    errorCode,
    attemptedAt,
    completedAt,
  };
}

async function finalizeAttempt(
  exec: SqlExecutor,
  input: {
    inventoryId: string;
    snapshotId: string;
    deviceId: string;
    operatorId: string;
    boxId: string;
    sscc: string;
    attemptId: string;
    eventId: string;
    kind: "initial" | "reprint";
    attemptNumber: number;
    result: "printed" | "failed";
    errorCode: InventoryPrintErrorCode | null;
    attemptedAt: string;
    completedAt: string;
    productionDate: string;
  },
): Promise<void> {
  const sequence = await allocateSequence(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.deviceId,
  );
  const repack = printMutation(
    input.kind,
    input.boxId,
    input.sscc,
    input.attemptId,
    input.attemptNumber,
    input.result,
    input.errorCode,
    input.attemptedAt,
    input.completedAt,
  );
  const event: InventoryEvent = inventoryEventSchema.parse({
    eventId: input.eventId,
    deviceSequence: sequence,
    operatorId: input.operatorId,
    scannedAt: input.completedAt,
    kind: "repack_action",
    normalizedIdentity: `repack_action:${repack.action}:${input.boxId}:${input.attemptNumber}`,
    codeHash: null,
    canonicalRaw: null,
    activeProductionDate: input.productionDate,
    localVerdict: "repack-action",
    repack,
  });
  await exec.run(
    `INSERT OR IGNORE INTO inventory_repack_print_journal
       (inventory_id, snapshot_id, attempt_id, box_id, device_id, event_id,
        device_sequence, operator_id, kind, attempt_number, result, error_code,
        attempted_at, completed_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.inventoryId,
      input.snapshotId,
      input.attemptId,
      input.boxId,
      input.deviceId,
      input.eventId,
      sequence,
      input.operatorId,
      input.kind,
      input.attemptNumber,
      input.result,
      input.errorCode,
      input.attemptedAt,
      input.completedAt,
      JSON.stringify(event),
    ],
  );
}

function labelInput(
  manifest: StationInventoryBundleManifest,
  row: BoxFactsRow,
): InventoryBoxLabelInput {
  return {
    sscc: row.new_sscc,
    quantity: row.quantity,
    productName: manifest.productName,
    productPrintName: manifest.productPrintName,
    gtin14: manifest.gtin14,
    egaisCode: manifest.egaisCode,
    shelfLifeDays: manifest.shelfLifeDays,
    productionDate: row.production_date,
  };
}

async function attemptInternal(
  input: AttemptInventoryBoxPrintInput,
): Promise<InventoryBoxPrintResult> {
  const kind = input.kind ?? "initial";
  const existing = (
    await listInventoryBoxPrintAttempts(
      input.exec,
      input.inventoryId,
      input.snapshotId,
      input.boxId,
    )
  ).find((attempt) => attempt.attemptId === input.attemptId);
  if (existing?.state === "printed" || existing?.state === "failed") {
    const row = await readBoxFacts(input.exec, input.inventoryId, input.snapshotId, input.boxId);
    if (!row) throw new Error("inventory box is not printable");
    return {
      state: existing.state,
      errorCode: existing.errorCode,
      sscc: row.new_sscc,
      quantity: row.quantity,
      productionDate: row.production_date,
      attemptNumber: existing.attemptNumber,
    };
  }
  const row = requirePrintable(
    await readBoxFacts(input.exec, input.inventoryId, input.snapshotId, input.boxId),
    input.deviceId,
    kind,
  );
  const attemptNumber = await claimAttempt(input.exec, { ...input, kind });
  const fields = inventoryBoxLabelFields(labelInput(input.manifest, row));
  const render =
    input.render ??
    ((
      template: LabelTemplateSpec,
      _fields: Record<LabelField, string>,
      language: PrinterLanguage,
    ) =>
      renderInventoryBoxLabel(
        template,
        labelInput(input.manifest, row),
        language,
        input.rasterizeText ?? rasterizeText,
      ));
  const physical = await attemptBoxPrint({
    template: input.manifest.boxLabelTemplate?.spec ?? null,
    fields,
    printing: input.printing,
    render,
  });
  const completedAt = input.completedAt();
  const result = physical.kind === "printed" ? "printed" : "failed";
  const errorCode = physical.kind === "printed" ? null : physical.code;
  try {
    await finalizeAttempt(input.exec, {
      ...input,
      kind,
      attemptNumber,
      result,
      errorCode,
      completedAt,
      productionDate: row.production_date,
      sscc: row.new_sscc,
    });
  } catch {
    await finalizeAttempt(input.exec, {
      ...input,
      kind,
      attemptNumber,
      result: "failed",
      errorCode: "persistence_failed",
      completedAt,
      productionDate: row.production_date,
      sscc: row.new_sscc,
    });
  }
  const [stored] = (
    await listInventoryBoxPrintAttempts(
      input.exec,
      input.inventoryId,
      input.snapshotId,
      input.boxId,
    )
  ).filter((attempt) => attempt.attemptId === input.attemptId);
  if (!stored || stored.state === "printing") throw new Error("inventory print persistence failed");
  return {
    state: stored.state,
    errorCode: stored.errorCode,
    sscc: row.new_sscc,
    quantity: row.quantity,
    productionDate: row.production_date,
    attemptNumber,
  };
}

export function attemptInventoryBoxPrint(
  input: AttemptInventoryBoxPrintInput,
): Promise<InventoryBoxPrintResult> {
  return serialized(`${input.inventoryId}:${input.snapshotId}:${input.boxId}`, () =>
    attemptInternal(input),
  );
}

export async function listInventoryBoxPrintAttempts(
  exec: SqlExecutor,
  inventoryId: string,
  snapshotId: string,
  boxId: string,
): Promise<InventoryPrintAttemptView[]> {
  const rows = await exec.all<{
    attempt_id: string;
    box_id: string;
    kind: "initial" | "reprint";
    attempt_number: number;
    state: "printing" | "printed" | "failed";
    error_code: InventoryPrintErrorCode | null;
    attempted_at: string;
    completed_at: string | null;
    event_id: string | null;
  }>(
    `SELECT attempt_id, box_id, kind, attempt_number, state, error_code,
            attempted_at, completed_at, event_id
       FROM inventory_repack_print_attempts
      WHERE inventory_id = ? AND snapshot_id = ? AND box_id = ?
      ORDER BY attempt_number`,
    [inventoryId, snapshotId, boxId],
  );
  return rows.map((row) => ({
    attemptId: row.attempt_id,
    boxId: row.box_id,
    kind: row.kind,
    attemptNumber: row.attempt_number,
    state: row.state,
    errorCode: row.error_code,
    attemptedAt: row.attempted_at,
    completedAt: row.completed_at,
    eventId: row.event_id,
  }));
}

export async function recoverInterruptedInventoryPrint(
  exec: SqlExecutor,
  input: {
    inventoryId: string;
    snapshotId: string;
    deviceId: string;
    operatorId: string;
    boxId: string;
    attemptId: string;
    eventId: string;
    completedAt: string;
  },
): Promise<void> {
  const attempts = await listInventoryBoxPrintAttempts(
    exec,
    input.inventoryId,
    input.snapshotId,
    input.boxId,
  );
  const attempt = attempts.find((row) => row.attemptId === input.attemptId);
  if (!attempt || attempt.state !== "printing") return;
  const row = await readBoxFacts(exec, input.inventoryId, input.snapshotId, input.boxId);
  if (!row || row.owner_device_id !== input.deviceId) {
    throw new Error("inventory box is not printable");
  }
  await finalizeAttempt(exec, {
    ...input,
    kind: attempt.kind,
    attemptNumber: attempt.attemptNumber,
    result: "failed",
    errorCode: "persistence_failed",
    attemptedAt: attempt.attemptedAt,
    productionDate: row.production_date,
    sscc: row.new_sscc,
  });
}

export async function findInventoryPrintedBoxBySscc(
  exec: SqlExecutor,
  input: {
    inventoryId: string;
    snapshotId: string;
    deviceId: string;
    sscc: string;
  },
): Promise<{
  boxId: string;
  sscc: string;
  quantity: number;
  productionDate: string;
} | null> {
  if (!/^[0-9]{18}$/.test(input.sscc)) return null;
  const rows = await exec.all<{
    box_id: string;
    new_sscc: string;
    production_date: string;
    quantity: number;
  }>(
    `SELECT box.box_id, box.new_sscc, box.production_date,
            COUNT(item.item_id) AS quantity
       FROM inventory_repack_boxes_mirror box
       INNER JOIN inventory_repack_items_mirror item
         ON item.inventory_id = box.inventory_id AND item.snapshot_id = box.snapshot_id
        AND item.box_id = box.box_id AND item.removed_at IS NULL
      WHERE box.inventory_id = ? AND box.snapshot_id = ? AND box.owner_device_id = ?
        AND box.new_sscc = ? AND box.state = 'closed' AND box.print_state = 'printed'
        AND box.invalidated_at IS NULL
      GROUP BY box.inventory_id, box.snapshot_id, box.box_id`,
    [input.inventoryId, input.snapshotId, input.deviceId, input.sscc],
  );
  const row = rows[0];
  return row
    ? {
        boxId: row.box_id,
        sscc: row.new_sscc,
        quantity: row.quantity,
        productionDate: row.production_date,
      }
    : null;
}
