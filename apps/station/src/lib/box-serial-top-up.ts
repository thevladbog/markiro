import { StationApiError, type StationClient } from "./api-client.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationIsCurrent,
  type CredentialGeneration,
} from "./credential-recovery.js";
import type { SqlExecutor } from "./mirror.js";
import { addRange, dropRanges, remaining, type ServerRange } from "./sscc-pool.js";

const LOW_WATER = 400;
const INITIAL_RETRY_MS = 15_000;
const MAX_RETRY_MS = 60_000;

interface TopUpResponse {
  blocks: ServerRange[];
  revokedFrom: number[];
  issuerProblem: "org_gln_missing" | "issuer_gln_missing" | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown, issuerPrefix: string): TopUpResponse {
  if (!isRecord(value) || !Array.isArray(value.blocks) || !Array.isArray(value.revokedFrom)) {
    throw new Error("Invalid box SSCC top-up response");
  }
  if (
    value.issuerProblem !== null &&
    value.issuerProblem !== "org_gln_missing" &&
    value.issuerProblem !== "issuer_gln_missing"
  ) {
    throw new Error("Invalid box SSCC issuer problem");
  }
  const blocks: ServerRange[] = value.blocks.map((block: unknown) => {
    if (
      !isRecord(block) ||
      block.issuerPrefix !== issuerPrefix ||
      block.extensionDigit !== 0 ||
      !Number.isSafeInteger(block.fromSerial) ||
      !Number.isSafeInteger(block.toSerial) ||
      (block.fromSerial as number) < 0 ||
      (block.toSerial as number) < (block.fromSerial as number) ||
      (block.consumedThroughSerial !== null &&
        (!Number.isSafeInteger(block.consumedThroughSerial) ||
          (block.consumedThroughSerial as number) < (block.fromSerial as number) - 1 ||
          (block.consumedThroughSerial as number) > (block.toSerial as number)))
    ) {
      throw new Error("Invalid box SSCC top-up block");
    }
    return {
      issuerPrefix,
      extensionDigit: 0,
      fromSerial: block.fromSerial as number,
      toSerial: block.toSerial as number,
      consumedThroughSerial: block.consumedThroughSerial as number | null,
    };
  });
  const revokedFrom = value.revokedFrom.map((serial: unknown) => {
    if (!Number.isSafeInteger(serial) || (serial as number) < 0) {
      throw new Error("Invalid box SSCC revocation");
    }
    return serial as number;
  });
  return { blocks, revokedFrom, issuerProblem: value.issuerProblem };
}

/** Independent of scan-batch sync: an empty outbox must not suppress replenishment. */
export function createBoxSerialTopUp(input: {
  client: Pick<StationClient, "post">;
  exec: SqlExecutor;
  shiftId: string;
  issuerPrefix: string;
  generation: CredentialGeneration;
  isCurrent: () => boolean;
  isOnline?: () => boolean;
  waitForBundle?: () => Promise<void>;
}): { nudge(): Promise<void>; stop(): void } {
  let stopped = false;
  let unsupported = false;
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = INITIAL_RETRY_MS;
  const online = input.isOnline ?? (() => typeof navigator === "undefined" || navigator.onLine);
  const current = () =>
    !stopped && input.isCurrent() && credentialGenerationIsCurrent(input.generation);

  function schedule(delay: number): void {
    if (!current() || unsupported || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void nudge();
    }, delay);
  }

  async function check(): Promise<void> {
    if (!current() || unsupported) return;
    if (!online()) {
      schedule(INITIAL_RETRY_MS);
      return;
    }
    try {
      if ((await remaining(input.exec, input.issuerPrefix, 0)) > LOW_WATER) return;
      if (!current()) return;
      const raw = await input.client.post<unknown>(`/shifts/${input.shiftId}/sscc/top-up`);
      if (!current()) return;
      const response = parseResponse(raw, input.issuerPrefix);
      // An entry bundle may have begun first and carries older revocations.
      // Let its pool writes finish before this newer server snapshot is applied.
      await input.waitForBundle?.();
      if (!current()) return;
      const lease = acquireCredentialCommitLease(input.generation);
      if (!lease) return;
      try {
        if (!current()) return;
        const liveStarts = new Set(response.blocks.map((block) => block.fromSerial));
        await dropRanges(
          input.exec,
          input.issuerPrefix,
          0,
          response.revokedFrom.filter((serial) => !liveStarts.has(serial)),
        );
        for (const block of response.blocks) {
          if (!current()) return;
          await addRange(input.exec, block);
        }
      } finally {
        lease.release();
      }
      retryDelay = INITIAL_RETRY_MS;
      if (current() && (await remaining(input.exec, input.issuerPrefix, 0)) <= LOW_WATER) {
        schedule(MAX_RETRY_MS);
      }
    } catch (error) {
      if (error instanceof StationApiError && error.status === 404) {
        unsupported = true;
        return;
      }
      schedule(retryDelay);
      retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
    }
  }

  function nudge(): Promise<void> {
    if (!current() || unsupported) return Promise.resolve();
    if (retryTimer !== null) return Promise.resolve();
    if (inFlight !== null) {
      queued = true;
      return inFlight;
    }
    inFlight = check().finally(() => {
      inFlight = null;
      if (queued && current()) {
        queued = false;
        void nudge();
      }
    });
    return inFlight;
  }

  return {
    nudge,
    stop() {
      stopped = true;
      queued = false;
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
    },
  };
}
