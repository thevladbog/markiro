import type { SqlExecutor } from "./mirror.js";
import { parsePrinterProfile, type PrinterProfile, type PrintPurpose } from "./printer-routing.js";

export interface PrintDestinationKey {
  scope: string;
  purpose: PrintPurpose;
  jobId: string;
  attemptId: string;
}
const where = "scope=? AND purpose=? AND job_id=? AND attempt_id=?";
const values = (key: PrintDestinationKey) => [key.scope, key.purpose, key.jobId, key.attemptId];

export async function readPrintDestination(
  exec: SqlExecutor,
  key: PrintDestinationKey,
): Promise<PrinterProfile | null> {
  const [row] = await exec.all<{ profile_json: string }>(
    `SELECT profile_json FROM printer_destinations WHERE ${where}`,
    values(key),
  );
  if (!row) return null;
  const profile = parsePrinterProfile(JSON.parse(row.profile_json));
  if (!profile) throw new Error("Invalid saved printer");
  return profile;
}

/** One-statement first-writer wins; safe with the pooled SQLite executor. */
export async function bindPrintDestination(
  exec: SqlExecutor,
  key: PrintDestinationKey,
  candidate: PrinterProfile | null,
): Promise<PrinterProfile | null> {
  if (candidate) {
    const profile = parsePrinterProfile(candidate);
    if (!profile) throw new Error("Invalid printer");
    await exec.run(
      `INSERT INTO printer_destinations(scope,purpose,job_id,attempt_id,profile_json) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [...values(key), JSON.stringify(profile)],
    );
  }
  return readPrintDestination(exec, key);
}

/** Caller must hold the print/credential lease and require an explicit recovery action. */
export async function replacePrintDestination(
  exec: SqlExecutor,
  key: PrintDestinationKey,
  expected: PrinterProfile,
  replacement: PrinterProfile,
): Promise<boolean> {
  const profile = parsePrinterProfile(replacement);
  if (!profile) throw new Error("Invalid printer");
  const rows = await exec.all<{ profile_json: string }>(
    `UPDATE printer_destinations SET profile_json=? WHERE ${where} AND profile_json=? RETURNING profile_json`,
    [JSON.stringify(profile), ...values(key), JSON.stringify(expected)],
  );
  return rows.length === 1;
}

/** An unaccepted scan has no print job; do not retain its speculative local binding. */
export async function discardUnacceptedPrintDestination(
  exec: SqlExecutor,
  scope: string,
  jobId: string,
): Promise<void> {
  await exec.run(
    `DELETE FROM printer_destinations WHERE scope=? AND purpose='duplicate' AND job_id=? AND NOT EXISTS (SELECT 1 FROM product_label_jobs WHERE credential_ownership=? AND job_id=?)`,
    [scope, jobId, scope, jobId],
  );
}
