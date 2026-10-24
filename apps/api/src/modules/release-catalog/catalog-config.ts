import { isAbsolute, relative, resolve, sep } from "node:path";
export interface CatalogStorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}
export interface CatalogCacheConfig {
  bucket: string;
  cacheDir: string;
  cacheBytes: number;
  maxObjectBytes: number;
  diskReserveBytes: number;
  maxDownloads: number;
  timeoutMs: number;
}
export interface CatalogConfig extends CatalogStorageConfig, CatalogCacheConfig {
  journalDir: string;
}
const keys = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CACHE_DIR",
  "JOURNAL_DIR",
  "CACHE_BYTES",
  "OBJECT_BYTES",
  "DISK_RESERVE_BYTES",
  "DOWNLOADS",
  "TIMEOUT_MS",
] as const;
/** No implicit production capacity or credential fallback to another storage role. */
export function configureCatalog(
  env: Readonly<Record<string, string | undefined>>,
): CatalogConfig | null {
  if (keys.every((key) => !env[`RELEASE_CATALOG_${key}`])) return null;
  try {
    const value = (key: (typeof keys)[number]) => {
      const v = env[`RELEASE_CATALOG_${key}`];
      if (!v || v !== v.trim() || /[\p{Cc}]/u.test(v)) throw new Error();
      return v;
    };
    const positive = (key: (typeof keys)[number]) => {
      const v = value(key);
      if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error();
      return Number(v);
    };
    const endpoint = value("S3_ENDPOINT"),
      url = new URL(endpoint),
      bucket = value("S3_BUCKET");
    if (
      url.protocol !== "https:" ||
      url.origin !== endpoint ||
      url.username ||
      url.password ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)
    )
      throw new Error();
    const cacheDir = value("CACHE_DIR"),
      journalDir = value("JOURNAL_DIR");
    const contains = (a: string, b: string) => {
      const rel = relative(a, b);
      return !rel || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    };
    if (
      !isAbsolute(cacheDir) ||
      !isAbsolute(journalDir) ||
      resolve(cacheDir) !== cacheDir ||
      resolve(journalDir) !== journalDir ||
      contains(cacheDir, journalDir) ||
      contains(journalDir, cacheDir)
    )
      throw new Error();
    const cacheBytes = positive("CACHE_BYTES"),
      maxObjectBytes = positive("OBJECT_BYTES"),
      diskReserveBytes = positive("DISK_RESERVE_BYTES"),
      maxDownloads = positive("DOWNLOADS"),
      timeoutMs = positive("TIMEOUT_MS");
    if (
      maxObjectBytes > 536870912 ||
      cacheBytes < maxObjectBytes ||
      maxDownloads > 2 ||
      timeoutMs > 3600000
    )
      throw new Error();
    return {
      endpoint,
      region: value("S3_REGION"),
      bucket,
      accessKeyId: value("S3_ACCESS_KEY_ID"),
      secretAccessKey: value("S3_SECRET_ACCESS_KEY"),
      cacheDir,
      journalDir,
      cacheBytes,
      maxObjectBytes,
      diskReserveBytes,
      maxDownloads,
      timeoutMs,
    };
  } catch {
    throw new Error("Invalid release catalog configuration");
  }
}
