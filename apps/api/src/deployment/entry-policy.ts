import { parseDeploymentEdition } from "@markiro/domain";
import { loadEnv, type Env } from "../env";

/** The historical RU executable never accepts a US deployment configuration. */
export function assertRuEntryEdition(value: unknown): void {
  if (value === undefined) return;
  if (parseDeploymentEdition(value) !== "RU")
    throw new Error("Use the explicit US API entry point");
}

function reject(field: string): never {
  throw new Error(`US development requires an isolated ${field}`);
}

function localUrl(
  raw: NodeJS.ProcessEnv,
  field: string,
  protocol: string,
  port: string,
  pathname: string,
): URL {
  let url: URL;
  try {
    url = new URL(raw[field] ?? "");
  } catch {
    return reject(field);
  }
  if (
    url.protocol !== protocol ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== port ||
    url.pathname !== pathname ||
    url.search ||
    url.hash
  )
    reject(field);
  return url;
}

/** Local-only until the owner separately approves a reviewed US release path. */
export function loadUsDevelopmentEnv(raw: NodeJS.ProcessEnv): Env {
  if (parseDeploymentEdition(raw.MARKIRO_DEPLOYMENT_EDITION) !== "US")
    reject("MARKIRO_DEPLOYMENT_EDITION");
  if (parseDeploymentEdition(raw.VITE_DEPLOYMENT_EDITION) !== "US")
    reject("VITE_DEPLOYMENT_EDITION");
  if (raw.NODE_ENV !== "development" && raw.NODE_ENV !== "test") reject("NODE_ENV");
  localUrl(raw, "DATABASE_URL", "postgres:", "55432", "/markiro_us_dev");
  for (const [field, port] of [
    ["BETTER_AUTH_URL", "3100"],
    ["PLATFORM_AUTH_URL", "3100"],
    ["ADMIN_ORIGIN", "5174"],
    ["SAAS_ADMIN_ORIGIN", "5474"],
    ["S3_ENDPOINT", "19000"],
  ] as const) {
    const url = localUrl(raw, field, "http:", port, "/");
    if (url.username || url.password) reject(field);
  }
  if (raw.PORT !== "3100") reject("PORT");
  if (!["127.0.0.1", "localhost"].includes(raw.SMTP_HOST ?? "")) reject("SMTP_HOST");
  if (raw.SMTP_PORT !== "11025" || raw.SMTP_SECURE !== "false") reject("SMTP_PORT/SMTP_SECURE");
  if (raw.S3_BUCKET !== "markiro-us-development") reject("S3_BUCKET");
  if (raw.S3_FORCE_PATH_STYLE !== "true") reject("S3_FORCE_PATH_STYLE");
  for (const field of [
    "DADATA_TOKEN",
    "DADATA_SECRET",
    "CHZ_TOKEN_ENCRYPTION_KEY",
    "NATIONAL_CATALOG_BASE_URL",
    "NATIONAL_CATALOG_SCHEMA_SOURCE_TENANT_ID",
    "KIOSK_ORIGIN",
    "STATION_ORIGIN",
  ]) {
    if (raw[field]?.trim()) reject(field);
  }
  if (raw.LANDING_DEMO_SUBMISSION_ENABLED !== "false") reject("LANDING_DEMO_SUBMISSION_ENABLED");
  try {
    return loadEnv(raw);
  } catch {
    throw new Error("US development configuration is invalid; check the local environment example");
  }
}
