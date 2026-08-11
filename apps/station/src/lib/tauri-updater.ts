import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import type {
  StationUpdateDownloadEvent,
  StationUpdateHandle,
  StationUpdaterPort,
} from "./use-station-updater.js";

const BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;

function invalid(): never {
  throw new Error("invalid station update state");
}

function parseVersion(value: unknown): [number, number, number, number] {
  if (typeof value !== "string") invalid();
  const match = BETA_VERSION.exec(value);
  if (!match) invalid();
  const parsed = match.slice(1).map(Number);
  if (!parsed.every(Number.isSafeInteger)) invalid();
  return parsed as [number, number, number, number];
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const leftValue = a[index] ?? 0;
    const rightValue = b[index] ?? 0;
    if (leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}

function canonicalDate(value: unknown): string {
  if (typeof value !== "string") invalid();
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value ||
    date.getTime() > Date.now()
  )
    invalid();
  return value;
}

function mapEvent(event: DownloadEvent): StationUpdateDownloadEvent {
  if (event.event === "Started") {
    return { event: "Started", contentLength: event.data.contentLength ?? null };
  }
  if (event.event === "Progress") return { event: "Progress", chunkLength: event.data.chunkLength };
  return { event: "Finished" };
}

function toHandle(update: Update): StationUpdateHandle {
  const currentVersion = update.currentVersion;
  const version = update.version;
  if (compareVersions(version, currentVersion) <= 0) invalid();
  const publishedAt = canonicalDate(update.date);
  return {
    currentVersion,
    version,
    publishedAt,
    async downloadAndInstall(onProgress) {
      await update.downloadAndInstall((event) => onProgress(mapEvent(event)));
    },
    close: () => update.close(),
  };
}

export const tauriStationUpdater: StationUpdaterPort = {
  async check() {
    const update = await check({ timeout: 15_000, allowDowngrades: false });
    if (!update) return null;
    try {
      return toHandle(update);
    } catch (error) {
      await update.close().catch(() => undefined);
      throw error;
    }
  },
  relaunch,
};
