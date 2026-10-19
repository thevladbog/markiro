import { constants } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isMainModule } from "../production/cli-main.mjs";
import { parsePlatformManifest } from "./release-manifest.mjs";

const fail = (key) => {
  throw new Error(`invalid platform configuration: ${key}`);
};
const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/;
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
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(env.S3_BUCKET)) fail("S3_BUCKET");
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
    if (!env.SMARTCAPTCHA_SERVER_KEY?.startsWith("ysc2_")) fail("SMARTCAPTCHA_SERVER_KEY");
  }
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
