import {
  palletLabelSourceSchema,
  palletProductionDeliverySchema,
  palletDeliveryDiagnosticSchema,
  resolveWarehouseReprintScan,
  type PalletDeliveryDiagnostic,
  type PalletProductionResolution,
} from "@markiro/domain";
import type { SqlExecutor } from "../mirror.js";
import {
  AUTHORIZED_CREDENTIAL_OWNERS_SQL,
  deviceRecoveryAllowsWork,
  readDeviceRecovery,
} from "../device-recovery.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "../credential-recovery.js";
import { stationOperatorIsCurrentlyActive } from "../offline-grants/admission.js";
import {
  recordPalletProductionResolution,
  readPalletProductionResolution,
} from "./pallet-resolution-store.js";
import { palletMembership } from "./pallet-sources.js";
export class PalletDeliveryError extends Error {
  constructor(
    message: string,
    readonly diagnostic: PalletDeliveryDiagnostic | null,
  ) {
    super(message);
  }
}
export async function localPalletDiagnostic(exec: SqlExecutor, owner: string, sscc: string) {
  const [row] = await exec.all<{ value_json: string; production_delivery_json: string | null }>(
    `SELECT value_json,production_delivery_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? AND eligibility_denied=0 AND receive_status<>'conflict' ORDER BY rowid ASC LIMIT 1`,
    [owner, sscc],
  );
  if (!row?.production_delivery_json) return null;
  const source = palletLabelSourceSchema.parse(JSON.parse(row.value_json)),
    receipt = palletProductionDeliverySchema.parse(JSON.parse(row.production_delivery_json)),
    recovery = await readDeviceRecovery(exec);
  const [mirror] = await exec.all<{ terminal_id: string | null }>(
    "SELECT terminal_id FROM pallets_mirror WHERE sscc=?",
    [sscc],
  );
  const scope =
    source.originalAttempt?.scope ?? JSON.stringify([source.shiftId, mirror?.terminal_id]);
  const [driver] = await exec.all<{ state: string }>(
    "SELECT state FROM printer_deliveries WHERE scope=? AND purpose='pallet' AND job_id=? AND attempt_id=? AND resolved_at IS NULL",
    [scope, sscc, receipt.attemptId],
  );
  return palletDeliveryDiagnosticSchema.parse({
    sscc,
    sourceRevision: source.revision,
    attemptId: receipt.attemptId,
    productionSequence: receipt.sequence,
    originDeviceId: mirror?.terminal_id ?? recovery?.owner?.deviceId ?? null,
    shiftId: source.shiftId,
    kind:
      driver?.state === "sending" || driver?.state === "prepared"
        ? driver.state
        : receipt.state === "sent"
          ? "sync_pending"
          : receipt.state,
  });
}
export async function palletOriginalIsResolved(
  exec: SqlExecutor,
  owner: string,
  sscc: string,
  receipt: Pick<
    ReturnType<typeof palletProductionDeliverySchema.parse>,
    "attemptId" | "sourceRevision" | "sequence"
  >,
) {
  const saved = await readPalletProductionResolution(exec, owner, sscc, receipt.attemptId);
  return saved &&
    saved.receiveStatus !== "conflict" &&
    saved.resolution.sourceRevision === receipt.sourceRevision &&
    saved.resolution.productionSequence === receipt.sequence
    ? saved
    : null;
}
export async function resolveOriginalPalletDelivery(input: {
  exec: SqlExecutor;
  owner: string;
  generation: CredentialGeneration;
  deviceId: string;
  operatorId: string;
  diagnostic: PalletDeliveryDiagnostic;
  outcome: "confirmed" | "skipped";
  scannedSscc?: string;
  reason: PalletProductionResolution["reason"];
}) {
  const { exec, owner, generation, diagnostic: d } = input;
  if (
    generation.sealed ||
    (await credentialGenerationOwnership(generation)) !== owner ||
    !(await deviceRecoveryAllowsWork(exec, generation)) ||
    !(await stationOperatorIsCurrentlyActive(exec, input.operatorId))
  )
    throw new Error("WAREHOUSE_OWNER_CHANGED");
  const actual = await localPalletDiagnostic(exec, owner, d.sscc),
    membership = await palletMembership(exec, d.sscc);
  if (
    !actual ||
    !membership ||
    membership.pallet.terminal_id !== input.deviceId ||
    actual.kind === "sending" ||
    actual.kind === "prepared" ||
    !d.attemptId ||
    !d.productionSequence ||
    !d.sourceRevision ||
    d.originDeviceId !== input.deviceId ||
    actual.attemptId !== d.attemptId ||
    actual.sourceRevision !== d.sourceRevision ||
    actual.productionSequence !== d.productionSequence
  )
    throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
  const [sourceRow] = await exec.all<{ value_json: string }>(
    `SELECT value_json FROM warehouse_pallet_sources WHERE owner IN (${AUTHORIZED_CREDENTIAL_OWNERS_SQL}) AND sscc=? ORDER BY rowid ASC LIMIT 1`,
    [owner, d.sscc],
  );
  if (!sourceRow) throw new Error("WAREHOUSE_PALLET_SOURCE_CHANGED");
  const source = palletLabelSourceSchema.parse(JSON.parse(sourceRow.value_json));
  if (
    membership.compositionDigest !== source.compositionDigest ||
    membership.pallet.shift_id !== source.shiftId ||
    new Date(membership.pallet.closed_at ?? "").toISOString() !== source.closedAt ||
    membership.pallet.box_count !== source.boxCount ||
    membership.pallet.item_count !== source.itemCount ||
    JSON.stringify(membership.boxes) !== JSON.stringify([...source.boxSsccs].sort())
  )
    throw new Error("WAREHOUSE_PALLET_COMPOSITION_CHANGED");
  const scan = input.scannedSscc ? resolveWarehouseReprintScan(input.scannedSscc) : null;
  if (
    input.outcome === "confirmed" &&
    (!scan || scan.kind !== "box" || scan.repair !== null || scan.sscc !== d.sscc)
  )
    throw new Error("WAREHOUSE_VERIFY_MISMATCH");
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new Error("WAREHOUSE_OWNER_CHANGED");
  try {
    await recordPalletProductionResolution(exec, owner, {
      eventId: crypto.randomUUID(),
      sscc: d.sscc,
      sourceRevision: d.sourceRevision,
      attemptId: d.attemptId,
      productionSequence: d.productionSequence,
      operatorId: input.operatorId,
      reason: input.reason,
      outcome: input.outcome,
      occurredAt: new Date().toISOString(),
      scannedSscc: input.outcome === "confirmed" && scan?.kind === "box" ? scan.sscc : null,
    });
  } finally {
    lease.release();
  }
}
