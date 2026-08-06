import { purgeOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { waitForShiftBundleMirrors } from "./shift-bundle.js";

export interface SealedWorkSummary {
  scans: number;
  boxes: number;
  exceptions: number;
  total: number;
}

export interface CredentialRejectedEvent {
  machineId: string;
  generation: CredentialGeneration;
}

export interface CredentialGeneration {
  sealed: boolean;
  rejectionPublished: boolean;
}

export function createCredentialGeneration(): CredentialGeneration {
  return { sealed: false, rejectionPublished: false };
}

export function credentialGenerationIsCurrent(generation: CredentialGeneration): boolean {
  return !generation.sealed;
}

/** Seals every engine sharing this key generation; only the first caller publishes recovery. */
export function sealCredentialGeneration(generation: CredentialGeneration): boolean {
  generation.sealed = true;
  if (generation.rejectionPublished) return false;
  generation.rejectionPublished = true;
  return true;
}

export interface FloorWorkBarrier {
  idle(): Promise<void>;
}

export interface FloorWorkRegistry {
  register(barrier: FloorWorkBarrier): () => void;
  current(): Iterable<FloorWorkBarrier>;
}

/** Reference-counted because StrictMode can register the same memoized queue twice. */
export function createFloorWorkRegistry(): FloorWorkRegistry {
  const registrations = new Map<FloorWorkBarrier, number>();
  return {
    register(barrier) {
      registrations.set(barrier, (registrations.get(barrier) ?? 0) + 1);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const remaining = (registrations.get(barrier) ?? 1) - 1;
        if (remaining === 0) registrations.delete(barrier);
        else registrations.set(barrier, remaining);
      };
    },
    current() {
      return registrations.keys();
    },
  };
}

export class FloorWorkBarrierTimeoutError extends Error {
  constructor() {
    super("floor work barrier timed out");
    this.name = "FloorWorkBarrierTimeoutError";
  }
}

export const FLOOR_WORK_BARRIER_TIMEOUT_MS = 5_000;

async function waitForFloorWork(
  barriers: Iterable<FloorWorkBarrier>,
  timeoutMs: number,
): Promise<void> {
  const pending = [...barriers].map((barrier) => barrier.idle());
  if (pending.length === 0) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(pending),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new FloorWorkBarrierTimeoutError()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Counts only facts that have not yet received a server acknowledgement. */
export async function readSealedWorkSummary(
  exec: SqlExecutor,
  floorWork: Iterable<FloorWorkBarrier> = [],
  timeoutMs = FLOOR_WORK_BARRIER_TIMEOUT_MS,
): Promise<SealedWorkSummary> {
  await waitForFloorWork(floorWork, timeoutMs);
  const rows = await exec.all<{ scans: number; boxes: number; exceptions: number }>(
    `SELECT
       (SELECT COUNT(*) FROM outbox) AS scans,
       (SELECT COUNT(*) FROM boxes_mirror
         WHERE closed_at IS NOT NULL AND acked_at IS NULL) AS boxes,
       (SELECT COUNT(*) FROM box_exceptions_mirror) AS exceptions`,
  );
  const scans = rows[0]?.scans ?? 0;
  const boxes = rows[0]?.boxes ?? 0;
  const exceptions = rows[0]?.exceptions ?? 0;
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
  // Serialized with roster publishing. The purge first installs a fail-closed
  // read gate, then strictly clears both slots and the selector; no deletion
  // failure is swallowed.
  await purgeOperatorsMirror(exec);
  await exec.run("DELETE FROM shift_mirror");
  await exec.run("DELETE FROM product_mirror");
}
