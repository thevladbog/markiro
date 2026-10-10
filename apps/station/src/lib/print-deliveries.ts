import { decodeMonoRaster, productLabelBytesDigest } from "@markiro/domain";
import type { SqlExecutor } from "./mirror.js";
import {
  bytesToBase64,
  tauriWindowsPrinting,
  type WindowsPrintResult,
  type WindowsPrinting,
} from "./hardware.js";
import { parsePrinterProfile, printerMode, type PrinterProfile } from "./printer-routing.js";
export interface WindowsDeliveryPreflight {
  profileJson: string;
  bytes: Uint8Array;
}
export class PrintDeliveryBeforeSendError extends Error {}
export interface DeliveryKey {
  scope: string;
  purpose: "test" | "box" | "pallet" | "duplicate";
  jobId: string;
  attemptId: string;
}
export interface PrintDeliveryRow {
  scope: string;
  purpose: DeliveryKey["purpose"];
  job_id: string;
  attempt_id: string;
  state: "prepared" | "sending" | "sent" | "failed_before_send" | "delivery_unknown";
  profile_json: string;
  artifact_digest: string;
  artifact_base64: string | null;
  document_name: string;
  receipt_json: string | null;
  error_code: string | null;
  resolved_at: string | null;
}
const where = "scope=? AND purpose=? AND job_id=? AND attempt_id=?";
const values = (key: DeliveryKey) => [key.scope, key.purpose, key.jobId, key.attemptId];
export async function readPrintDelivery(
  exec: SqlExecutor,
  key: DeliveryKey,
): Promise<PrintDeliveryRow | null> {
  return (
    (
      await exec.all<PrintDeliveryRow>(
        `SELECT * FROM printer_deliveries WHERE ${where}`,
        values(key),
      )
    )[0] ?? null
  );
}
export async function preparePrintDelivery(
  exec: SqlExecutor,
  key: DeliveryKey,
  profile: PrinterProfile,
  bytes: Uint8Array,
): Promise<PrintDeliveryRow> {
  const page = decodeMonoRaster(bytes);
  const parsed = parsePrinterProfile(profile);
  if (!parsed || printerMode(parsed) !== "windows_driver" || parsed.dpi !== page.dpi)
    throw new Error("Invalid Windows profile");
  const digest = productLabelBytesDigest(bytes),
    json = JSON.stringify(parsed);
  await exec.run(
    `INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES(?,?,?,?,'prepared',?,?,?,?,?) ON CONFLICT DO NOTHING`,
    [
      ...values(key),
      json,
      digest,
      key.purpose === "duplicate" ? null : bytesToBase64(bytes),
      `Markiro:${crypto.randomUUID()}`,
      new Date().toISOString(),
    ],
  );
  const row = await readPrintDelivery(exec, key);
  if (!row || row.artifact_digest !== digest || row.profile_json !== json)
    throw new Error("Print delivery identity changed");
  return row;
}
/** Caller holds its existing credential/production lease. Destination CAS runs in this statement. */
export async function claimPrintDelivery(exec: SqlExecutor, key: DeliveryKey): Promise<boolean> {
  const rows = await exec.all<{ attempt_id: string }>(
    `UPDATE printer_deliveries SET state='sending',updated_at=? WHERE ${where} AND state='prepared' AND (purpose='test' OR EXISTS(SELECT 1 FROM printer_destinations p WHERE p.scope=printer_deliveries.scope AND p.purpose=printer_deliveries.purpose AND p.job_id=printer_deliveries.job_id AND p.attempt_id=printer_deliveries.attempt_id AND p.profile_json=printer_deliveries.profile_json)) RETURNING attempt_id`,
    [new Date().toISOString(), ...values(key)],
  );
  return rows.length === 1;
}
export async function recordPrintDeliveryResult(
  exec: SqlExecutor,
  key: DeliveryKey,
  result: WindowsPrintResult,
): Promise<void> {
  const row = await readPrintDelivery(exec, key);
  if (!row) throw new Error("Print delivery missing");
  const receipt = result.ok ? result.receipt : result.error.receipt;
  const profile = parsePrinterProfile(JSON.parse(row.profile_json));
  if (
    receipt &&
    (receipt.documentName !== row.document_name ||
      profile?.target.kind !== "usb" ||
      receipt.queue !== profile.target.printer ||
      !Number.isSafeInteger(receipt.jobId) ||
      receipt.jobId < 1)
  )
    throw new Error("Print receipt identity changed");
  await exec.run(
    `UPDATE printer_deliveries SET state=CASE WHEN state='sending' THEN ? ELSE state END,receipt_json=COALESCE(receipt_json,?),error_code=CASE WHEN state='sending' THEN ? ELSE error_code END,updated_at=? WHERE ${where} AND (state='sending' OR (state='delivery_unknown' AND receipt_json IS NULL))`,
    [
      result.ok
        ? "sent"
        : result.error.phase === "before_start"
          ? "failed_before_send"
          : "delivery_unknown",
      receipt ? JSON.stringify(receipt) : null,
      result.ok ? null : result.error.code,
      new Date().toISOString(),
      ...values(key),
    ],
  );
}
const live = new Set<string>();
const identity = (key: DeliveryKey) => JSON.stringify(values(key));
export async function dispatchWindowsDelivery(
  exec: SqlExecutor,
  key: DeliveryKey,
  profile: PrinterProfile,
  bytes: Uint8Array,
  hardware: WindowsPrinting = tauriWindowsPrinting,
  isCurrent: () => boolean = () => true,
  preflighted?: WindowsDeliveryPreflight,
): Promise<void> {
  const row = await preparePrintDelivery(exec, key, profile, bytes);
  if (row.state !== "prepared") throw new Error("PRINT_DELIVERY_REQUIRES_RECOVERY");
  if (profile.target.kind !== "usb") throw new Error("Windows queue required");
  // Reuse only the exact in-memory page and printer snapshot checked by this caller.
  // Native print still validates geometry before StartDoc.
  const preflight =
    preflighted?.bytes === bytes && preflighted.profileJson === JSON.stringify(profile)
      ? { ok: true as const }
      : await hardware.preflightWindowsRaster(profile.target.printer, bytes);
  if (!preflight.ok) {
    await exec.run(
      `UPDATE printer_deliveries SET state='failed_before_send',error_code=?,updated_at=? WHERE ${where} AND state='prepared'`,
      [preflight.error.code, new Date().toISOString(), ...values(key)],
    );
    throw new PrintDeliveryBeforeSendError(preflight.error.code);
  }
  const id = identity(key);
  if (live.has(id)) throw new Error("Print is still active");
  live.add(id);
  try {
    if (!(await claimPrintDelivery(exec, key))) throw new Error("PRINT_DELIVERY_REQUIRES_RECOVERY");
    if (!isCurrent()) {
      await exec.run(
        `UPDATE printer_deliveries SET state='failed_before_send',error_code='owner_changed',updated_at=? WHERE ${where} AND state='sending'`,
        [new Date().toISOString(), ...values(key)],
      );
      throw new PrintDeliveryBeforeSendError("owner_changed");
    }
    let result: WindowsPrintResult;
    try {
      result = await hardware.printWindowsRaster(profile.target.printer, bytes, row.document_name);
    } catch {
      result = { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } };
    }
    await recordPrintDeliveryResult(exec, key, result);
    if (!result.ok)
      throw result.error.phase === "before_start"
        ? new PrintDeliveryBeforeSendError(result.error.code)
        : new Error(result.error.code);
  } finally {
    live.delete(id);
  }
}
/** Never called as a resend: old claims become visible recovery facts. */
export async function recoverPrintDeliveries(exec: SqlExecutor): Promise<void> {
  const rows = await exec.all<PrintDeliveryRow>(
    "SELECT * FROM printer_deliveries WHERE state='sending'",
  );
  for (const row of rows) {
    const key = {
      scope: row.scope,
      purpose: row.purpose,
      jobId: row.job_id,
      attemptId: row.attempt_id,
    };
    if (!live.has(identity(key)))
      await exec.run(
        `UPDATE printer_deliveries SET state='delivery_unknown',error_code='interrupted',updated_at=? WHERE ${where} AND state='sending'`,
        [new Date().toISOString(), ...values(key)],
      );
  }
}
/** Explicit operator recovery resolves uncertainty, without inventing physical verification. */
export async function resolvePrintDelivery(exec: SqlExecutor, key: DeliveryKey): Promise<void> {
  await exec.run(
    `UPDATE printer_deliveries SET resolved_at=?,updated_at=? WHERE ${where} AND state<>'sending'`,
    [new Date().toISOString(), new Date().toISOString(), ...values(key)],
  );
}

/** Unknown delivery replays frozen bytes; proven non-sends and settled boxes may regenerate. */
export async function prepareWindowsReprint(
  exec: SqlExecutor,
  key: DeliveryKey,
  profile: PrinterProfile,
  render?: () => Promise<Uint8Array>,
): Promise<{ key: DeliveryKey; bytes: Uint8Array } | null> {
  await recoverPrintDeliveries(exec);
  const [previous] = await exec.all<PrintDeliveryRow>(
    `SELECT * FROM printer_deliveries WHERE scope=? AND purpose=? AND job_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`,
    [key.scope, key.purpose, key.jobId],
  );
  if (!previous) return null;
  if (previous.state === "sending") throw new Error("Print is still active");
  let bytes: Uint8Array;
  if (
    previous.state === "failed_before_send" ||
    (!previous.artifact_base64 && (previous.state === "sent" || previous.resolved_at))
  ) {
    if (!render) throw new Error("Label regeneration required");
    bytes = await render();
  } else {
    if (!previous.artifact_base64) throw new Error("Saved raster unavailable");
    bytes = Uint8Array.from(atob(previous.artifact_base64), (c) => c.charCodeAt(0));
    if (productLabelBytesDigest(bytes) !== previous.artifact_digest)
      throw new Error("Saved raster changed");
  }
  if (decodeMonoRaster(bytes).dpi !== profile.dpi) throw new Error("Incompatible saved raster");
  const next = { ...key, attemptId: crypto.randomUUID() };
  await exec.run(
    `INSERT INTO printer_destinations(scope,purpose,job_id,attempt_id,profile_json) VALUES(?,?,?,?,?)`,
    [...values(next), JSON.stringify(profile)],
  );
  await preparePrintDelivery(exec, next, profile, bytes);
  await resolvePrintDelivery(exec, {
    scope: previous.scope,
    purpose: previous.purpose,
    jobId: previous.job_id,
    attemptId: previous.attempt_id,
  });
  return { key: next, bytes };
}
