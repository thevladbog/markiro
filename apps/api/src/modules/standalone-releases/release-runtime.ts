import { createHash } from "node:crypto";
import type { CatalogReadSource } from "../release-catalog/catalog-read";
import { Logger } from "@nestjs/common";
import { standaloneLatestPointerSchema } from "@markiro/platform-contracts";
import type { StandaloneLatestBuildSource } from "../standalone-diagnostics/standalone-diagnostics.service";
import { configureStandaloneReleases, type StandaloneReleasesEnvironment } from "./release-config";
import { S3StandaloneReleaseStore } from "./release-store";
import type { StandaloneReleasesRuntime } from "./standalone-releases.service";

export function createStandaloneReleasesRuntime(
  env: StandaloneReleasesEnvironment,
): StandaloneReleasesRuntime | null {
  const config = configureStandaloneReleases(env);
  return config ? { config, store: new S3StandaloneReleaseStore(config) } : null;
}

/** Catalog availability is observed on every read; a fenced channel is unknown immediately. */
export function standaloneLatestBuildSource(
  source: CatalogReadSource | null,
): StandaloneLatestBuildSource {
  const logger = new Logger("StandaloneLatestBuild");
  return {
    async latestPublishedVersion() {
      if (!source) return null;
      try {
        const snapshot = await source.readSnapshot("/standalone/stable/latest.json");
        if (
          !snapshot ||
          snapshot.kind !== "pointer" ||
          snapshot.bytes.length > 65536 ||
          createHash("sha256").update(snapshot.bytes).digest("hex") !== snapshot.sha256
        )
          return null;
        const parsed = standaloneLatestPointerSchema.safeParse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes)),
        );
        return parsed.success && parsed.data.channel === "stable" ? parsed.data.version : null;
      } catch {
        logger.warn("The standalone catalog channel is unavailable");
        return null;
      }
    },
  };
}
