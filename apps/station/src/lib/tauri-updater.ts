import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import type {
  StationUpdateDownloadEvent,
  StationUpdateHandle,
  StationUpdaterPort,
} from "./use-station-updater.js";
import { compareStationVersions, isStationBetaVersion } from "./station-version.js";

function invalid(): never {
  throw new Error("invalid station update state");
}

function canonicalDate(value: unknown): string {
  if (typeof value !== "string") invalid();
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() > Date.now() + 5 * 60_000) invalid();
  return date.toISOString();
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
  if (!isStationBetaVersion(version)) invalid();
  if (compareStationVersions(version, currentVersion) <= 0) invalid();
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
