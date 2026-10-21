/**
 * Access to the public release bucket (spec 2026-10-20 §5.4, owner decision
 * 2026-10-21): the bucket that already serves the Station at
 * `https://releases.markiro.app`, prefix `standalone/`, with keys of its own. All
 * five storage values absent keeps the API up and the section «не настроено»; a
 * partial or malformed set fails startup. Errors never carry a key.
 */
export interface StandaloneReleasesEnvironment {
  RELEASES_S3_ENDPOINT?: string | undefined;
  RELEASES_S3_REGION?: string | undefined;
  RELEASES_S3_BUCKET?: string | undefined;
  RELEASES_S3_ACCESS_KEY_ID?: string | undefined;
  RELEASES_S3_SECRET_ACCESS_KEY?: string | undefined;
  RELEASES_PUBLIC_ORIGIN?: string | undefined;
}
export interface StandaloneReleasesConfig {
  /** An exact origin; uploads use path-style URLs on it, so it is also the admin CSP's. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Where the bucket is read publicly; `latest.json` links point here. */
  publicOrigin: string;
}

export const DEFAULT_RELEASES_PUBLIC_ORIGIN = "https://releases.markiro.app";
export const STANDALONE_RELEASES_CONFIG_ERROR = "Invalid standalone release storage configuration";
const STORAGE_KEYS = [
  "RELEASES_S3_ENDPOINT",
  "RELEASES_S3_REGION",
  "RELEASES_S3_BUCKET",
  "RELEASES_S3_ACCESS_KEY_ID",
  "RELEASES_S3_SECRET_ACCESS_KEY",
] as const;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function exactOrigin(value: string, allowLoopbackHttp: boolean): string {
  const url = new URL(value);
  const plainHttp = url.protocol === "http:" && allowLoopbackHttp && LOOPBACK.has(url.hostname);
  if (
    (url.protocol !== "https:" && !plainHttp) ||
    url.origin !== value ||
    url.username ||
    url.password
  )
    throw new Error();
  return url.origin;
}

export function configureStandaloneReleases(
  env: StandaloneReleasesEnvironment,
): StandaloneReleasesConfig | null {
  const present = STORAGE_KEYS.filter((key) => (env[key] ?? "") !== "");
  if (present.length === 0) return null;
  try {
    if (present.length !== STORAGE_KEYS.length) throw new Error();
    const {
      RELEASES_S3_ENDPOINT: endpoint = "",
      RELEASES_S3_REGION: region = "",
      RELEASES_S3_BUCKET: bucket = "",
      RELEASES_S3_ACCESS_KEY_ID: accessKeyId = "",
      RELEASES_S3_SECRET_ACCESS_KEY: secretAccessKey = "",
    } = env;
    if (!BUCKET.test(bucket)) throw new Error();
    return {
      endpoint: exactOrigin(endpoint, true),
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      publicOrigin: exactOrigin(
        env.RELEASES_PUBLIC_ORIGIN || DEFAULT_RELEASES_PUBLIC_ORIGIN,
        false,
      ),
    };
  } catch {
    throw new Error(STANDALONE_RELEASES_CONFIG_ERROR);
  }
}
