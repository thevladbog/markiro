import { readFile } from "node:fs/promises";

export const SIGNER_TAURI_CONFIG = "apps/signer/src-tauri/tauri.conf.json";

/** The single source of the release version; nothing else may name it. */
export async function readSignerVersion(configPath = SIGNER_TAURI_CONFIG) {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const version = config?.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${configPath} has no usable semantic version`);
  }
  return version;
}

export function signerReleaseTag(version) {
  return `signer-v${version}`;
}

export function assertTagIsFree(tag, existingTags) {
  if (existingTags.includes(tag)) {
    throw new Error(
      `${tag} is already published; bump "version" in ${SIGNER_TAURI_CONFIG} rather than republishing`,
    );
  }
}

/**
 * `targets: ["nsis"]` with `createUpdaterArtifacts` yields the setup .exe and
 * a sibling .sig. The .exe is both the installer a human downloads and the
 * bundle the updater fetches, so there is exactly one artifact plus its
 * signature.
 */
export function signerArtifactNames(version) {
  const installer = `markiro-signer-${version}-windows-x86_64-setup.exe`;
  return { installer, signature: `${installer}.sig` };
}
