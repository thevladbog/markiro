import { Channel, invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  StationUpdaterCommandError,
  type StationUpdateDownloadEvent,
  type StationUpdateFallbackReason,
  type StationUpdateHandle,
  type StationUpdateOrigin,
  type StationUpdatePackageFallbackReason,
  type StationUpdaterCommandErrorCode,
  type StationUpdaterPort,
} from "./use-station-updater.js";
import { compareStationVersions, parseStationVersion } from "./station-version.js";

const MAX_CANDIDATE_ID_BYTES = 128;
const FUTURE_DATE_TOLERANCE_MS = 5 * 60_000;

const COMMAND_ERROR_RETRYABLE: Record<StationUpdaterCommandErrorCode, boolean> = {
  "origins-unavailable": true,
  "origin-mismatch": false,
  "integrity-failed": false,
  "policy-denied": false,
  "check-superseded": false,
  "candidate-invalid": false,
  "candidate-expired": false,
  "installation-failed": false,
  internal: false,
};

interface DecodedStationUpdate {
  candidateId: string;
  currentVersion: string;
  version: string;
  publishedAt: string;
  origin: StationUpdateOrigin;
  fallbackReason: StationUpdateFallbackReason | null;
}

function invalid(kind: "result" | "error" | "progress"): never {
  throw new Error(`invalid station update ${kind}`);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  kind: "result" | "error" | "progress",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(kind);
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    invalid(kind);
  }
  return record;
}

function candidateId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > MAX_CANDIDATE_ID_BYTES
  ) {
    invalid("result");
  }
  return value;
}

function recoverableCandidateId(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    return candidateId((value as Record<string, unknown>).candidateId);
  } catch {
    return null;
  }
}

function canonicalVersion(value: unknown): string {
  if (typeof value !== "string") invalid("result");
  try {
    parseStationVersion(value);
  } catch {
    invalid("result");
  }
  return value;
}

function canonicalDate(value: unknown): string {
  if (typeof value !== "string") invalid("result");
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value ||
    date.getTime() > Date.now() + FUTURE_DATE_TOLERANCE_MS
  ) {
    invalid("result");
  }
  return value;
}

function decodeOrigin(value: unknown, kind: "result" | "progress"): StationUpdateOrigin {
  if (value !== "yandex" && value !== "github") invalid(kind);
  return value;
}

function decodeFallbackReason(value: unknown): StationUpdateFallbackReason | null {
  if (value === null) return null;
  if (value !== "primary-unavailable" && value !== "primary-metadata-invalid") invalid("result");
  return value;
}

function decodePackageFallbackReason(value: unknown): StationUpdatePackageFallbackReason {
  if (value !== "http" && value !== "network" && value !== "timeout") invalid("progress");
  return value;
}

function decodeUpdate(value: unknown): DecodedStationUpdate {
  const record = exactRecord(
    value,
    ["candidateId", "currentVersion", "version", "publishedAt", "selectedOrigin", "fallbackReason"],
    "result",
  );
  const currentVersion = canonicalVersion(record.currentVersion);
  const version = canonicalVersion(record.version);
  if (currentVersion.includes("-beta.") !== version.includes("-beta.")) invalid("result");
  if (compareStationVersions(version, currentVersion) <= 0) invalid("result");
  const origin = decodeOrigin(record.selectedOrigin, "result");
  const fallbackReason = decodeFallbackReason(record.fallbackReason);
  if ((origin === "yandex") !== (fallbackReason === null)) invalid("result");
  return {
    candidateId: candidateId(record.candidateId),
    currentVersion,
    version,
    publishedAt: canonicalDate(record.publishedAt),
    origin,
    fallbackReason,
  };
}

function decodeCommandError(value: unknown): StationUpdaterCommandError {
  const record = exactRecord(value, ["code", "retryable"], "error");
  if (typeof record.code !== "string" || !(record.code in COMMAND_ERROR_RETRYABLE)) {
    invalid("error");
  }
  const code = record.code as StationUpdaterCommandErrorCode;
  if (typeof record.retryable !== "boolean" || record.retryable !== COMMAND_ERROR_RETRYABLE[code]) {
    invalid("error");
  }
  return new StationUpdaterCommandError(code, record.retryable);
}

function safeInteger(value: unknown, allowZero: boolean): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    invalid("progress");
  }
  return value;
}

function decodeProgress(value: unknown): StationUpdateDownloadEvent {
  const outer = exactRecord(
    value,
    (value as { event?: unknown } | null)?.event === "Finished" ? ["event"] : ["event", "data"],
    "progress",
  );
  if (outer.event === "Started") {
    const data = exactRecord(outer.data, ["contentLength"], "progress");
    return {
      event: "Started",
      contentLength: data.contentLength === null ? null : safeInteger(data.contentLength, true),
    };
  }
  if (outer.event === "Progress") {
    const data = exactRecord(outer.data, ["chunkLength"], "progress");
    return { event: "Progress", chunkLength: safeInteger(data.chunkLength, false) };
  }
  if (outer.event === "Fallback") {
    const data = exactRecord(outer.data, ["from", "to", "reason"], "progress");
    const from = decodeOrigin(data.from, "progress");
    const to = decodeOrigin(data.to, "progress");
    if (from !== "yandex" || to !== "github") invalid("progress");
    return { event: "Fallback", from, to, reason: decodePackageFallbackReason(data.reason) };
  }
  if (outer.event === "Finished") return { event: "Finished" };
  invalid("progress");
}

async function invokeStation(command: string, payload?: Record<string, unknown>): Promise<unknown> {
  try {
    return await invoke<unknown>(command, payload);
  } catch (error) {
    throw decodeCommandError(error);
  }
}

function expectVoid(value: unknown): void {
  if (value !== null) invalid("result");
}

function toHandle(update: DecodedStationUpdate): StationUpdateHandle {
  let closePromise: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closePromise ??= invokeStation("station_update_close", {
      request: { candidateId: update.candidateId },
    }).then(expectVoid);
    return closePromise;
  };

  return {
    currentVersion: update.currentVersion,
    version: update.version,
    publishedAt: update.publishedAt,
    origin: update.origin,
    fallbackReason: update.fallbackReason,
    async downloadAndInstall(onProgress) {
      const progressFailure: { error: Error | null; close: Promise<void> | null } = {
        error: null,
        close: null,
      };
      const progress = new Channel<unknown>((payload) => {
        let decoded: StationUpdateDownloadEvent;
        try {
          decoded = decodeProgress(payload);
        } catch (error) {
          progressFailure.error =
            error instanceof Error ? error : new Error("invalid station update progress");
          progressFailure.close = close().catch(() => undefined);
          return;
        }
        onProgress(decoded);
      });

      let result: unknown;
      try {
        result = await invokeStation("station_update_download_and_install", {
          request: { candidateId: update.candidateId },
          progress,
        });
      } catch (error) {
        if (progressFailure.error) throw progressFailure.error;
        throw error instanceof Error ? error : new Error("station update request failed");
      }
      if (progressFailure.close) await progressFailure.close;
      if (progressFailure.error) throw progressFailure.error;
      expectVoid(result);
    },
    close,
  };
}

export const tauriStationUpdater: StationUpdaterPort = {
  async check() {
    const result = await invokeStation("station_update_check", undefined);
    if (result === null) return null;
    const id = recoverableCandidateId(result);
    try {
      return toHandle(decodeUpdate(result));
    } catch (error) {
      if (id) {
        await invokeStation("station_update_close", { request: { candidateId: id } }).catch(
          () => undefined,
        );
      }
      throw error;
    }
  },
  relaunch,
};
