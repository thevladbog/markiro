/** The one channel the released agent is configured to poll. */
export const SIGNER_CHANNEL_BASE_URL = "https://releases.markiro.app/signer/stable";

export function buildSignerManifest({ version, pubDate, bundleUrl, signature }) {
  if (typeof signature !== "string" || signature.trim().length === 0) {
    throw new Error("signer manifest needs a non-empty signature");
  }
  if (typeof bundleUrl !== "string" || !bundleUrl.startsWith(`${SIGNER_CHANNEL_BASE_URL}/`)) {
    throw new Error(`bundle URL must live under ${SIGNER_CHANNEL_BASE_URL} (signer/stable)`);
  }
  const manifest = {
    version,
    pub_date: pubDate,
    platforms: { "windows-x86_64": { url: bundleUrl, signature } },
  };
  assertValidSignerManifest(manifest);
  return manifest;
}

export function assertValidSignerManifest(manifest) {
  const invalid = () => {
    throw new Error("invalid signer manifest");
  };
  if (!manifest || typeof manifest !== "object") invalid();
  if (Object.keys(manifest).sort().join(",") !== "platforms,pub_date,version") invalid();
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) invalid();
  if (typeof manifest.pub_date !== "string" || Number.isNaN(Date.parse(manifest.pub_date))) {
    invalid();
  }
  if (!manifest.platforms || Object.keys(manifest.platforms).join(",") !== "windows-x86_64") {
    invalid();
  }
  const platform = manifest.platforms["windows-x86_64"];
  if (Object.keys(platform).sort().join(",") !== "signature,url") invalid();
  if (typeof platform.url !== "string" || typeof platform.signature !== "string") invalid();
}
