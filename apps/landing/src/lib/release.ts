/**
 * The pointer to the latest published installer of «Маркиро Автоном»
 * (spec 2026-10-20, section 5.3). The file is unsigned: trust is carried by the
 * signed manifest next to it, which the host checks on update. The page therefore
 * accepts only links into the public release bucket and shows the SHA-256 for a
 * manual check.
 */

export const RELEASES_ORIGIN = "https://releases.markiro.app";
export const LATEST_RELEASE_URL = `${RELEASES_ORIGIN}/standalone/stable/latest.json`;
const RELEASE_PATH_PREFIX = "/standalone/stable/";

export interface StandaloneRelease {
  readonly version: string;
  readonly releasedAt: string;
  readonly installerUrl: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly notes: readonly string[];
}

const VERSION_PATTERN = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,32})?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FILE_NAME_PATTERN = /^markiro-standalone-[0-9A-Za-z.-]+-windows-x86_64-setup\.exe$/;
const MAX_INSTALLER_BYTES = 2 * 1024 * 1024 * 1024;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function installerLink(value: unknown, version: string): { url: string; fileName: string } | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== RELEASES_ORIGIN) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  if (!url.pathname.startsWith(`${RELEASE_PATH_PREFIX}${version}/`)) return null;
  const fileName = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
  if (!FILE_NAME_PATTERN.test(fileName) || !fileName.includes(`-${version}-`)) return null;
  return { url: url.href, fileName };
}

/** Returns `null` for anything that is not a well-formed stable pointer of this product. */
export function parseLatestRelease(value: unknown): StandaloneRelease | null {
  const root = asRecord(value);
  if (root === null) return null;
  if (root.v !== 1 || root.product !== "markiro-standalone" || root.channel !== "stable") {
    return null;
  }
  const version = root.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) return null;
  const releasedAt = root.releasedAt;
  if (typeof releasedAt !== "string" || Number.isNaN(Date.parse(releasedAt))) return null;

  const installer = asRecord(root.installer);
  if (installer === null) return null;
  const link = installerLink(installer.url, version);
  if (link === null) return null;
  const sha256 = installer.sha256;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  const sizeBytes = installer.sizeBytes;
  if (
    typeof sizeBytes !== "number" ||
    !Number.isInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > MAX_INSTALLER_BYTES
  ) {
    return null;
  }

  const notes = Array.isArray(root.notes)
    ? root.notes.filter((note): note is string => typeof note === "string").slice(0, 10)
    : [];

  return {
    version,
    releasedAt,
    installerUrl: link.url,
    fileName: link.fileName,
    sha256,
    sizeBytes,
    notes,
  };
}

const RELEASE_DATE = new Intl.DateTimeFormat("ru-RU", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Moscow",
});

/** The release instant as the civil date in Moscow, «18.10.2026». */
export function formatReleaseDate(releasedAt: string): string {
  return RELEASE_DATE.format(new Date(releasedAt));
}

/** Windows shows binary megabytes as «МБ»; the page uses the same unit. */
export function formatInstallerSize(sizeBytes: number): string {
  return `${Math.max(1, Math.round(sizeBytes / (1024 * 1024)))} МБ`;
}

export function hashCommand(fileName: string): string {
  return `Get-FileHash .\\${fileName} -Algorithm SHA256`;
}
