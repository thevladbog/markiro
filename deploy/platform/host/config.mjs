import { createHash } from "node:crypto";
import { rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
import {
  assertBindFileSync,
  assertPrivateFileSync,
  assertPrivateRoot,
  assertPrivateRootSync,
  createPrivateDirectory,
  privateFileError,
  readPrivateFile,
  syncPrivateDirectory,
  writePrivateFile,
} from "./files.mjs";

// Explicit inventory from env.example, including its commented optional keys.
// Disabled worker switches are the only additional preflight-supported keys.
const runtimeKeys = new Set([
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
  "ACME_EMAIL",
  "DATABASE_URL",
  "PLATFORM_AUTH_SECRET",
  "MAIL_PAYLOAD_ENCRYPTION_KEY",
  "S3_ENDPOINT",
  "S3_PUBLIC_ORIGIN",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_FORCE_PATH_STYLE",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SECURE",
  "SMTP_USER",
  "SMTP_PASSWORD",
  "SMTP_FROM_EMAIL",
  "SMTP_FROM_NAME",
  "SMTP_REPLY_TO",
  "LANDING_DEMO_SUBMISSION_ENABLED",
  "LANDING_DEMO_RECIPIENT",
  "LANDING_DEMO_REPLY_TO",
  "SMARTCAPTCHA_SERVER_KEY",
  "SUPPORT_CHAT_ENABLED",
  "SUPPORT_CHATWOOT_BASE_URL",
  "SUPPORT_CHATWOOT_ACCOUNT_ID",
  "SUPPORT_CHATWOOT_INBOX_ID",
  "SUPPORT_CHATWOOT_API_TOKEN",
  "STANDALONE_LICENSE_ISSUER",
  "STANDALONE_LICENSE_KID",
  "STANDALONE_LICENSE_PRIVATE_KEY_PEM",
  "STANDALONE_LICENSE_KEYSET_JSON",
  "STANDALONE_SUPPORT_KEYS_JSON",
  "CHZ_TOKEN_ENCRYPTION_KEY",
  "NATIONAL_CATALOG_OWN_IMPORT_ENABLED",
  "NATIONAL_CATALOG_GTIN_IMPORT_ENABLED",
  "NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED",
  "VALIDATION_DM_DUPLICATE_ENABLED",
  "MARKIRO_POSTGRES_IMAGE_DIGEST",
  "MARKIRO_POSTGRES_CA_FILE",
  "MARKIRO_POSTGRES_SERVER_CERT_FILE",
  "MARKIRO_POSTGRES_SERVER_KEY_FILE",
  "MARKIRO_POSTGRES_PASSWORD_FILE",
]);
const domainKeys = [
  "MARKIRO_SAAS_ADMIN_DOMAIN",
  "MARKIRO_LANDING_DOMAIN",
  "MARKIRO_RETIRED_ADMIN_DOMAIN",
  "MARKIRO_RETIRED_KIOSK_DOMAIN",
];
const pgFiles = [
  "MARKIRO_POSTGRES_CA_FILE",
  "MARKIRO_POSTGRES_SERVER_CERT_FILE",
  "MARKIRO_POSTGRES_SERVER_KEY_FILE",
  "MARKIRO_POSTGRES_PASSWORD_FILE",
];
const interpolationKeys = [
  "MARKIRO_API_IMAGE_DIGEST",
  "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
  ...domainKeys,
  "MARKIRO_SOURCE_SHA",
  "S3_PUBLIC_ORIGIN",
  "ACME_EMAIL",
  "MARKIRO_POSTGRES_IMAGE_DIGEST",
  ...pgFiles,
  "MARKIRO_PLATFORM_ENV_FILE",
];
const domain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;

function validateInterpolation(value) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== interpolationKeys.length
  )
    throw privateFileError();
  for (const key of interpolationKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      !descriptor ||
      !descriptor.enumerable ||
      typeof descriptor.value !== "string" ||
      [...descriptor.value].some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      throw privateFileError();
  }
  for (const key of [
    "MARKIRO_API_IMAGE_DIGEST",
    "MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST",
    "MARKIRO_POSTGRES_IMAGE_DIGEST",
  ])
    if (!digest.test(value[key])) throw privateFileError();
  if (!/^[a-f0-9]{40}$/u.test(value.MARKIRO_SOURCE_SHA)) throw privateFileError();
  for (const key of domainKeys) if (!domain.test(value[key])) throw privateFileError();
  if (new Set(domainKeys.map((key) => value[key])).size !== domainKeys.length)
    throw privateFileError();
  const origin = new URL(value.S3_PUBLIC_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.origin !== value.S3_PUBLIC_ORIGIN ||
    origin.username ||
    origin.password ||
    !domain.test(origin.hostname)
  )
    throw privateFileError();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.ACME_EMAIL)) throw privateFileError();
  for (const key of pgFiles) assertBindFileSync(value[key]);
  assertPrivateFileSync(value.MARKIRO_PLATFORM_ENV_FILE);
}

function validateRuntime(env, manifest) {
  if (Object.keys(env).some((key) => !runtimeKeys.has(key))) throw privateFileError();
  validateConfig(env, manifest);
}

export async function snapshotHostConfig({ root, candidateId, envFile, manifest }) {
  let candidateCreated = false;
  let snapshotWritten = false;
  let candidate;
  let path;
  try {
    await assertPrivateRoot(root);
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(
        candidateId,
      )
    )
      throw privateFileError();
    assertPrivateFileSync(envFile);
    const env = await readProtectedEnv(envFile);
    validateRuntime(env, manifest);
    // Validate compact bindings before creating anything. Snapshot path is checked
    // after publication because it must already exist at child construction.
    for (const key of pgFiles) assertBindFileSync(env[key]);
    if (!digest.test(env.MARKIRO_POSTGRES_IMAGE_DIGEST ?? "")) throw privateFileError();
    await createPrivateDirectory(root, "candidates", { exclusive: false });
    candidate = join(root, "candidates", candidateId);
    await createPrivateDirectory(root, `candidates/${candidateId}`);
    candidateCreated = true;
    path = join(candidate, "runtime.env");
    const bytes = Buffer.from(
      Object.keys(env)
        .sort()
        .map((key) => `${key}=${env[key]}\n`)
        .join(""),
    );
    await writePrivateFile(root, `candidates/${candidateId}/runtime.env`, bytes);
    snapshotWritten = true;
    const persisted = await readProtectedEnv(path);
    validateRuntime(persisted, manifest);
    const actual = await readPrivateFile(root, `candidates/${candidateId}/runtime.env`);
    if (!actual.equals(bytes)) throw privateFileError();
    const interpolation = Object.freeze(
      Object.fromEntries(
        interpolationKeys.map((key) => [
          key,
          key === "MARKIRO_PLATFORM_ENV_FILE" ? path : persisted[key],
        ]),
      ),
    );
    validateInterpolation(interpolation);
    return { path, sha256: createHash("sha256").update(actual).digest("hex"), interpolation };
  } catch (error) {
    // Never remove a pre-existing candidate or an uncertain published write.
    let durabilityUncertain = error.durabilityUncertain === true;
    if (candidateCreated && !durabilityUncertain) {
      const cleanupFailed = () => {
        durabilityUncertain = true;
      };
      if (snapshotWritten) await unlink(path).catch(cleanupFailed);
      await rmdir(candidate).catch(cleanupFailed);
      await syncPrivateDirectory(dirname(candidate)).catch(cleanupFailed);
    }
    throw privateFileError(durabilityUncertain);
  }
}

export function hostChildEnvironment({ interpolation, dockerConfig, ambient = process.env }) {
  try {
    if (!ambient || typeof ambient !== "object") throw privateFileError();
    for (const key of Object.keys(ambient))
      if (
        /^(?:COMPOSE_|LD_|DYLD_)/u.test(key) ||
        /^(?:DOCKER_HOST|DOCKER_CONTEXT|NODE_OPTIONS|NODE_PATH)$/u.test(key) ||
        /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu.test(key)
      )
        throw privateFileError();
    assertPrivateRootSync(dockerConfig);
    validateInterpolation(interpolation);
    return {
      PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      DOCKER_CONFIG: dockerConfig,
      COMPOSE_DISABLE_ENV_FILE: "1",
      ...interpolation,
    };
  } catch {
    throw privateFileError();
  }
}
