import { Logger } from "@nestjs/common";
import {
  standaloneLatestObjectKey,
  standaloneLatestPointerSchema,
} from "@markiro/platform-contracts";
import type { StandaloneLatestBuildSource } from "../standalone-diagnostics/standalone-diagnostics.service";
import { configureStandaloneReleases, type StandaloneReleasesEnvironment } from "./release-config";
import { S3StandaloneReleaseStore, type StandaloneReleaseStore } from "./release-store";
import type { StandaloneReleasesRuntime } from "./standalone-releases.service";

export function createStandaloneReleasesRuntime(
  env: StandaloneReleasesEnvironment,
): StandaloneReleasesRuntime | null {
  const config = configureStandaloneReleases(env);
  return config ? { config, store: new S3StandaloneReleaseStore(config) } : null;
}

const LATEST_CACHE_MS = 60_000;

/**
 * The newest published build for the diagnostics overview (spec 2026-10-20 §5.3):
 * the version the stable `latest.json` points at. Unconfigured storage, a missing
 * or unreadable pointer and a storage failure all read as «unknown» (`null`), so
 * the overview never fails or calls a host outdated on a guess.
 */
export function standaloneLatestBuildSource(
  store: StandaloneReleaseStore | null,
  now: () => number = Date.now,
): StandaloneLatestBuildSource {
  let cached: { at: number; version: string | null } | null = null;
  const logger = new Logger("StandaloneLatestBuild");
  return {
    async latestPublishedVersion() {
      if (!store) return null;
      if (cached && now() - cached.at < LATEST_CACHE_MS) return cached.version;
      let version: string | null = null;
      try {
        const bytes = await store.read(standaloneLatestObjectKey("stable"), 64 * 1024);
        const parsed = bytes
          ? standaloneLatestPointerSchema.safeParse(JSON.parse(bytes.toString("utf8")))
          : null;
        version = parsed?.success && parsed.data.channel === "stable" ? parsed.data.version : null;
      } catch {
        logger.warn("The stable standalone latest.json could not be read");
      }
      cached = { at: now(), version };
      return version;
    },
  };
}
