import { validateCatalogConfig } from "./catalog-config.mjs";
import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isMainModule } from "../production/cli-main.mjs";
import { parsePlatformManifest } from "./release-manifest.mjs";

const fail = (key) => {
  throw new Error(`invalid platform configuration: ${key}`);
};
const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/;
/**
 * Timeweb S3, path-style: the release bucket's upload origin, which `saas_admin_csp`
 * in the Caddyfile allows exactly, and the upstream `releases_upstream` reads from.
 */
export const RELEASES_UPLOAD_ORIGIN = "https://s3.twcstorage.ru";
const bucketName = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const RELEASES_STORAGE_KEYS = [
  "RELEASES_S3_ENDPOINT",
  "RELEASES_S3_REGION",
  "RELEASES_S3_BUCKET",
  "RELEASES_S3_ACCESS_KEY_ID",
  "RELEASES_S3_SECRET_ACCESS_KEY",
];
const required = [
  "SERVER_PROFILE",
  "VITE_SERVER_PROFILE",
  "MARKIRO_SOURCE_SHA",
  "MARKIRO_TOOLING_SHA",
  "MARKIRO_API_IMAGE_DIGEST",
  "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
  "MARKIRO_SAAS_ADMIN_DOMAIN",
  "MARKIRO_LANDING_DOMAIN",
  "MARKIRO_RETIRED_ADMIN_DOMAIN",
  "MARKIRO_RETIRED_KIOSK_DOMAIN",
  "MARKIRO_RELEASES_DOMAIN",
  "MARKIRO_RELEASES_BUCKET",
  "SAAS_ADMIN_ORIGIN",
  "PLATFORM_AUTH_URL",
  "LANDING_ORIGIN",
  "S3_ENDPOINT",
  "S3_PUBLIC_ORIGIN",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "DATABASE_URL",
  "PLATFORM_AUTH_SECRET",
  "MAIL_PAYLOAD_ENCRYPTION_KEY",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  "ACME_EMAIL",
  "LANDING_DEMO_SUBMISSION_ENABLED",
];

export async function readProtectedEnv(path) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("protected env file");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid() ||
      info.size > 1024 * 1024
    )
      fail("protected env file");
    const text = await handle.readFile("utf8");
    const result = Object.create(null);
    for (const line of text.split(/\r?\n/u)) {
      if (!line || line.startsWith("#")) continue;
      const match = /^([A-Z][A-Z0-9_]*)=([^\r\n\0]*)$/u.exec(line);
      if (
        !match ||
        Object.hasOwn(result, match[1]) ||
        /^["']/u.test(match[2]) ||
        match[2].includes("${") ||
        match[2].trim() !== match[2]
      )
        fail("protected env syntax");
      result[match[1]] = match[2];
    }
    return result;
  } catch {
    fail("protected env file");
  } finally {
    await handle?.close();
  }
}

function exactHttpsOrigin(value, key) {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== value ||
      parsed.username ||
      parsed.password ||
      !domain.test(parsed.hostname)
    )
      fail(key);
    return parsed;
  } catch {
    fail(key);
  }
}

/** Validate platform identities and delivery routing before accepting the release configuration. */
export function validateConfig(env, manifest) {
  if (
    env.PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA !== undefined &&
    !["true", "false"].includes(env.PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA)
  )
    fail("PLATFORM_PGBOSS_PREPROVISIONED_SCHEMA");
  for (const key of required) if (typeof env[key] !== "string" || !env[key].trim()) fail(key);
  const release = parsePlatformManifest(JSON.stringify(manifest), manifest?.workflowRunId);
  for (const key of ["SERVER_PROFILE", "VITE_SERVER_PROFILE"])
    if (env[key] !== "platform-only") fail(key);
  const bindings = {
    MARKIRO_SOURCE_SHA: release.sourceSha,
    MARKIRO_TOOLING_SHA: release.toolingSha,
    MARKIRO_API_IMAGE_DIGEST: release.api.split("@")[1],
    MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: release.edge.split("@")[1],
  };
  for (const [key, value] of Object.entries(bindings)) if (env[key] !== value) fail(key);
  const domains = [
    "MARKIRO_SAAS_ADMIN_DOMAIN",
    "MARKIRO_LANDING_DOMAIN",
    "MARKIRO_RETIRED_ADMIN_DOMAIN",
    "MARKIRO_RETIRED_KIOSK_DOMAIN",
    "MARKIRO_RELEASES_DOMAIN",
  ];
  for (const key of domains) if (!domain.test(env[key])) fail(key);
  if (new Set(domains.map((key) => env[key])).size !== domains.length) fail("distinct domains");
  for (const [key, host] of [
    ["SAAS_ADMIN_ORIGIN", "MARKIRO_SAAS_ADMIN_DOMAIN"],
    ["PLATFORM_AUTH_URL", "MARKIRO_SAAS_ADMIN_DOMAIN"],
    ["LANDING_ORIGIN", "MARKIRO_LANDING_DOMAIN"],
  ])
    if (env[key] !== `https://${env[host]}`) fail(key);
  for (const key of ["S3_ENDPOINT", "S3_PUBLIC_ORIGIN"]) exactHttpsOrigin(env[key], key);
  let db;
  try {
    db = new URL(env.DATABASE_URL);
  } catch {
    fail("DATABASE_URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(db.protocol) ||
    !db.hostname ||
    !db.username ||
    !db.password ||
    db.pathname.length < 2 ||
    db.searchParams.get("sslmode") !== "verify-full"
  )
    fail("DATABASE_URL");
  const dbParameters = [...db.searchParams.keys()];
  if (new Set(dbParameters).size !== dbParameters.length) fail("DATABASE_URL duplicate parameters");
  if (env.PLATFORM_AUTH_SECRET.length < 32) fail("PLATFORM_AUTH_SECRET");
  const mailKey = Buffer.from(env.MAIL_PAYLOAD_ENCRYPTION_KEY, "base64");
  if (mailKey.length !== 32 || mailKey.toString("base64") !== env.MAIL_PAYLOAD_ENCRYPTION_KEY)
    fail("MAIL_PAYLOAD_ENCRYPTION_KEY");
  if (!bucketName.test(env.S3_BUCKET)) fail("S3_BUCKET");
  // The edge reads release objects anonymously from this bucket; private media
  // must never become reachable through the public release host.
  if (
    !bucketName.test(env.MARKIRO_RELEASES_BUCKET) ||
    env.MARKIRO_RELEASES_BUCKET === env.S3_BUCKET
  )
    fail("MARKIRO_RELEASES_BUCKET");
  for (const key of ["SMTP_SECURE", "S3_FORCE_PATH_STYLE", "LANDING_DEMO_SUBMISSION_ENABLED"])
    if (!["true", "false"].includes(env[key])) fail(key);
  if (
    !domain.test(env.SMTP_HOST) ||
    !["465", "587"].includes(env.SMTP_PORT) ||
    env.SMTP_SECURE !== String(env.SMTP_PORT === "465")
  )
    fail("SMTP TLS");
  for (const key of ["SMTP_FROM_EMAIL", "ACME_EMAIL"])
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(env[key])) fail(key);
  const storage = new URL(env.S3_ENDPOINT);
  if (env.S3_FORCE_PATH_STYLE === "false")
    storage.hostname = `${env.S3_BUCKET}.${storage.hostname}`;
  if (env.S3_PUBLIC_ORIGIN !== storage.origin) fail("S3_PUBLIC_ORIGIN presigner mismatch");
  if (env.LANDING_DEMO_SUBMISSION_ENABLED === "true") {
    for (const key of ["LANDING_DEMO_RECIPIENT", "LANDING_DEMO_REPLY_TO"])
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(env[key] ?? "")) fail(key);
  }
  // Landing lead alerts are optional and never gate readiness: Telegram only
  // needs a token and at least one chat when it is switched on. The token is never echoed;
  // `fail` names the key only.
  if (env.LEAD_TELEGRAM_ENABLED && !["true", "false"].includes(env.LEAD_TELEGRAM_ENABLED))
    fail("LEAD_TELEGRAM_ENABLED");
  if (env.LEAD_TELEGRAM_ENABLED === "true") {
    if (!/^\d{1,20}:[A-Za-z0-9_-]{20,100}$/u.test(env.LEAD_TELEGRAM_BOT_TOKEN ?? ""))
      fail("LEAD_TELEGRAM_BOT_TOKEN");
    if (!env.LEAD_TELEGRAM_CHAT_ID && !env.LEAD_TELEGRAM_GROUP_CHAT_ID)
      fail("LEAD_TELEGRAM_CHAT_ID");
    for (const key of ["LEAD_TELEGRAM_CHAT_ID", "LEAD_TELEGRAM_GROUP_CHAT_ID"])
      if (env[key] && !/^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/u.test(env[key])) fail(key);
  }
  if (
    env.LEAD_RETENTION_MONTHS !== undefined &&
    !(
      /^[0-9]{1,2}$/u.test(env.LEAD_RETENTION_MONTHS) &&
      Number(env.LEAD_RETENTION_MONTHS) >= 1 &&
      Number(env.LEAD_RETENTION_MONTHS) <= 12
    )
  )
    fail("LEAD_RETENTION_MONTHS");
  // «Выпуски автонома» are optional and never gate readiness. The bucket's keys
  // come as a set; the endpoint must be the upload origin the admin CSP allows,
  // since the browser PUTs path-style to it, and the bucket the one the edge
  // serves, or a published release would never reach the download page. Keys
  // are never echoed.
  const releaseStorage = RELEASES_STORAGE_KEYS.filter((key) => env[key]);
  if (releaseStorage.length > 0) {
    for (const key of RELEASES_STORAGE_KEYS) if (!env[key]) fail(key);
    if (env.RELEASES_S3_ENDPOINT !== RELEASES_UPLOAD_ORIGIN) fail("RELEASES_S3_ENDPOINT");
    if (env.RELEASES_S3_BUCKET !== env.MARKIRO_RELEASES_BUCKET) fail("RELEASES_S3_BUCKET");
  }
  if (env.RELEASES_PUBLIC_ORIGIN !== undefined)
    exactHttpsOrigin(env.RELEASES_PUBLIC_ORIGIN, "RELEASES_PUBLIC_ORIGIN");
  // The API links installers under this origin (its default is the production
  // host); they must resolve on the site the edge serves.
  if (
    releaseStorage.length > 0 &&
    (env.RELEASES_PUBLIC_ORIGIN || "https://releases.markiro.app") !==
      `https://${env.MARKIRO_RELEASES_DOMAIN}`
  )
    fail("RELEASES_PUBLIC_ORIGIN");
  // Disabled product surfaces must not accidentally inherit legacy credentials,
  // workers or deferred CRM configuration from a shared env file.
  for (const key of [
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "PAIRING_CODE_PEPPER",
    "KIOSK_ORIGIN",
    "STATION_ORIGIN",
  ])
    if (env[key]) fail(key);
  for (const key of [
    "NATIONAL_CATALOG_OWN_IMPORT_ENABLED",
    "NATIONAL_CATALOG_GTIN_IMPORT_ENABLED",
    "NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED",
    "VALIDATION_DM_DUPLICATE_ENABLED",
  ])
    if (env[key] && env[key] !== "false") fail(key);
  if (env.SUPPORT_CHAT_ENABLED && !["true", "false"].includes(env.SUPPORT_CHAT_ENABLED))
    fail("SUPPORT_CHAT_ENABLED");
  if (env.SUPPORT_CHAT_ENABLED === "true") {
    exactHttpsOrigin(env.SUPPORT_CHATWOOT_BASE_URL, "SUPPORT_CHATWOOT_BASE_URL");
    for (const key of ["SUPPORT_CHATWOOT_ACCOUNT_ID", "SUPPORT_CHATWOOT_INBOX_ID"])
      if (!/^[1-9][0-9]*$/u.test(env[key] ?? "")) fail(key);
    if (!env.SUPPORT_CHATWOOT_API_TOKEN) fail("SUPPORT_CHATWOOT_API_TOKEN");
  }
  validateCatalogConfig(env);
  return release;
}

if (isMainModule(import.meta.url)) {
  try {
    const [file, manifestPath, runId] = process.argv.slice(2);
    if (!file || !manifestPath || !runId || process.argv.length !== 5) fail("arguments");
    const env = await readProtectedEnv(file);
    const manifest = parsePlatformManifest(await readFile(manifestPath, "utf8"), runId);
    validateConfig(env, manifest);
    process.stdout.write(
      "Platform preparation preflight passed (configuration only; no infrastructure checked).\n",
    );
  } catch {
    process.stderr.write(
      "Platform preflight failed; protected configuration or manifest is invalid.\n",
    );
    process.exitCode = 1;
  }
}
