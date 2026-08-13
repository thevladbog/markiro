import { purgeOperatorsMirror, type SqlExecutor } from "./mirror.js";
import { waitForShiftBundleMirrors } from "./shift-bundle.js";
import { clearStationProductImages, waitForStationProductImageMirrors } from "./product-image-cache.js";

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
  readonly phase: "active" | "sealing" | "sealed";
  /** True from sealing intent onward, so requests/retries stop immediately. */
  readonly sealed: boolean;
  readonly rejectionPublished: boolean;
}

interface CredentialGenerationLifecycle {
  phase: CredentialGeneration["phase"];
  activeCommits: number;
  rejectionPublished: boolean;
  settle: Promise<void> | null;
  resolveSettle: (() => void) | null;
}

const credentialGenerationLifecycles = new WeakMap<
  CredentialGeneration,
  CredentialGenerationLifecycle
>();

export function createCredentialGeneration(): CredentialGeneration {
  const lifecycle: CredentialGenerationLifecycle = {
    phase: "active",
    activeCommits: 0,
    rejectionPublished: false,
    settle: null,
    resolveSettle: null,
  };
  const generation = {} as CredentialGeneration;
  Object.defineProperties(generation, {
    phase: { enumerable: true, get: () => lifecycle.phase },
    sealed: { enumerable: true, get: () => lifecycle.phase !== "active" },
    rejectionPublished: { enumerable: true, get: () => lifecycle.rejectionPublished },
  });
  credentialGenerationLifecycles.set(generation, lifecycle);
  return generation;
}

export function credentialGenerationIsCurrent(generation: CredentialGeneration): boolean {
  return !generation.sealed;
}

function credentialLifecycle(generation: CredentialGeneration): CredentialGenerationLifecycle {
  const lifecycle = credentialGenerationLifecycles.get(generation);
  if (!lifecycle) throw new Error("unknown credential generation");
  return lifecycle;
}

export interface CredentialCommitLease {
  release(): void;
}

/** Atomically refuses a new local commit as soon as sealing intent exists. */
export function acquireCredentialCommitLease(
  generation: CredentialGeneration,
): CredentialCommitLease | null {
  const lifecycle = credentialLifecycle(generation);
  if (lifecycle.phase !== "active") return null;
  lifecycle.activeCommits += 1;
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      lifecycle.activeCommits -= 1;
      if (lifecycle.activeCommits === 0 && lifecycle.phase === "sealing") {
        lifecycle.phase = "sealed";
        lifecycle.resolveSettle?.();
        lifecycle.resolveSettle = null;
      }
    },
  };
}

/**
 * Enters sealing synchronously, waits every already-issued local commit
 * lease, then lets exactly one caller publish recovery from stable storage.
 */
export async function sealCredentialGeneration(generation: CredentialGeneration): Promise<boolean> {
  const lifecycle = credentialLifecycle(generation);
  const first = lifecycle.phase === "active";
  if (first) {
    lifecycle.phase = "sealing";
    lifecycle.rejectionPublished = true;
    if (lifecycle.activeCommits === 0) {
      lifecycle.phase = "sealed";
    } else {
      lifecycle.settle = new Promise<void>((resolve) => {
        lifecycle.resolveSettle = resolve;
      });
    }
  }
  if (lifecycle.settle) await lifecycle.settle;
  return first;
}

/**
 * Shared terminal boundary for every authenticated surface using one API key.
 * Sealing intent is installed synchronously by `sealCredentialGeneration`
 * before its first await; publication waits any commit lease that was already
 * issued and happens exactly once for the generation.
 */
export async function rejectCredentialGeneration(
  event: CredentialRejectedEvent,
  onCredentialRejected?: (event: CredentialRejectedEvent) => void,
): Promise<void> {
  if (await sealCredentialGeneration(event.generation)) {
    onCredentialRejected?.(event);
  }
}

export interface FloorWorkBarrier {
  close?: () => Promise<void>;
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

export interface FloorWorkRetirement {
  wait(timeoutMs?: number): Promise<void>;
}

async function waitForPendingFloorWork(pending: Promise<void>[], timeoutMs: number): Promise<void> {
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

async function waitForFloorWork(
  barriers: Iterable<FloorWorkBarrier>,
  timeoutMs: number,
): Promise<void> {
  await waitForPendingFloorWork(
    [...barriers].map((barrier) => barrier.idle()),
    timeoutMs,
  );
}

/** Stops new floor intake, then waits for every already accepted local write. */
export function beginFloorWorkRetirement(
  barriers: Iterable<FloorWorkBarrier>,
): FloorWorkRetirement {
  const snapshot = [...barriers];
  const pending = snapshot.map((barrier) => {
    try {
      return barrier.close ? barrier.close() : barrier.idle();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
  const settled = Promise.all(pending).then(() => undefined);
  return {
    wait(timeoutMs = FLOOR_WORK_BARRIER_TIMEOUT_MS) {
      return waitForPendingFloorWork([settled], timeoutMs);
    },
  };
}

/** Stops new floor intake, then waits for every already accepted local write. */
export async function retireFloorWork(
  barriers: Iterable<FloorWorkBarrier>,
  timeoutMs = FLOOR_WORK_BARRIER_TIMEOUT_MS,
): Promise<void> {
  await beginFloorWorkRetirement(barriers).wait(timeoutMs);
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
  await waitForStationProductImageMirrors();
  // Serialized with roster publishing. The purge first installs a fail-closed
  // read gate, then strictly clears both slots and the selector; no deletion
  // failure is swallowed.
  await purgeOperatorsMirror(exec);
  await exec.run("DELETE FROM shift_mirror");
  await exec.run("DELETE FROM product_mirror");
  await clearStationProductImages(exec);
}
