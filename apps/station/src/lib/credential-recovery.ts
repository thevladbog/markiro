import { replaceOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { waitForShiftBundleMirrors } from "./shift-bundle.js";

export interface SealedWorkSummary {
  scans: number;
  boxes: number;
  exceptions: number;
  total: number;
}

export interface CredentialRejectedEvent {
  machineId: string;
  sealed: SealedWorkSummary;
}

/** Counts only facts that have not yet received a server acknowledgement. */
export async function readSealedWorkSummary(exec: SqlExecutor): Promise<SealedWorkSummary> {
  const [scanRows, boxRows, exceptionRows] = await Promise.all([
    exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM outbox"),
    exec.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM boxes_mirror
        WHERE closed_at IS NOT NULL AND acked_at IS NULL`,
    ),
    exec.all<{ n: number }>("SELECT COUNT(*) AS n FROM box_exceptions_mirror"),
  ]);
  const scans = scanRows[0]?.n ?? 0;
  const boxes = boxRows[0]?.n ?? 0;
  const exceptions = exceptionRows[0]?.n ?? 0;
  return { scans, boxes, exceptions, total: scans + boxes + exceptions };
}

interface ClearRejectedCredentialStateDeps {
  exec: SqlExecutor;
  clearCredential: () => Promise<void>;
}

/**
 * Removes only state the same device can reproduce after pairing again.
 *
 * The durable shell credential is cleared first. If that boundary fails, no
 * local cache is changed. The SQL below is intentionally a closed allowlist:
 *
 * - both operator slots and their selector contain only a downloaded roster;
 * - shift/product rows contain only downloaded API reference bundles;
 * - outbox, codes, scan events, boxes, exceptions, conflicts, SSCC ranges,
 *   install identity, and every sync ceiling/batch id are deliberately absent.
 */
export async function clearRejectedCredentialState({
  exec,
  clearCredential,
}: ClearRejectedCredentialStateDeps): Promise<void> {
  await clearCredential();
  // A bundle request can have passed server authorization just before the
  // key was revoked. Let every already-started download/write settle, then
  // delete its reproducible rows so a late 200 cannot repopulate them.
  await waitForShiftBundleMirrors();
  // Use the roster publisher's serialization chain. A roster request that
  // started before the 401 may still be finishing; publishing an empty
  // generation after it guarantees that late response cannot restore a
  // rejected credential's operator hashes after this clear returns.
  await replaceOperatorsMirror(exec, []);
  await exec.run("DELETE FROM shift_mirror");
  await exec.run("DELETE FROM product_mirror");
  await exec.run("DELETE FROM station_meta WHERE key = ?", ["operators_slot"]);
}
