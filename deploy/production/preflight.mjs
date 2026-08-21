import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { productionComposeArgs } from "./compose-files.mjs";
import { validateProductionDomains, validateVbtechDomains } from "./production-domain.mjs";

const IMAGE_TAG_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const VBTECH_IMAGE_PATTERN = /^ghcr\.io\/thevladbog\/vbtech-web@(sha256:[0-9a-f]{64})$/;
const RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;
const VBTECH_FUNCTION_ORIGIN_PATTERN = /^https:\/\/functions\.yandexcloud\.net\/[A-Za-z0-9_-]+$/;
const COMPOSE_TIMEOUT_MS = 30_000;
const TERMINATION_GRACE_MS = 1_000;
const STDERR_LIMIT_BYTES = 8 * 1024;

function isEmail(value) {
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function invalid(variable) {
  return new Error(`${variable} is invalid`);
}

function parseVbtechConfig(environment, reservedDomains) {
  const keys = [
    "VBTECH_IMAGE_REF",
    "VBTECH_RELEASE_SHA",
    "VBTECH_DOMAIN",
    "VBTECH_WWW_DOMAIN",
    "VBTECH_FUNCTION_ORIGIN",
    "VBTECH_SUBMISSION_STATE",
  ];
  if (keys.every((key) => environment[key] === undefined)) return undefined;

  const imageRef = environment.VBTECH_IMAGE_REF;
  const imageMatch = typeof imageRef === "string" ? imageRef.match(VBTECH_IMAGE_PATTERN) : null;
  if (!imageMatch) throw invalid("VBTECH_IMAGE_REF");
  const releaseSha = environment.VBTECH_RELEASE_SHA;
  if (typeof releaseSha !== "string" || !RELEASE_SHA_PATTERN.test(releaseSha))
    throw invalid("VBTECH_RELEASE_SHA");
  const { domain, wwwDomain } = validateVbtechDomains(
    environment.VBTECH_DOMAIN,
    environment.VBTECH_WWW_DOMAIN,
    reservedDomains,
  );

  const submissionState = environment.VBTECH_SUBMISSION_STATE;
  if (submissionState !== "disabled" && submissionState !== "enabled")
    throw invalid("VBTECH_SUBMISSION_STATE");

  const parseFunctionOrigin = () => {
    if (
      typeof environment.VBTECH_FUNCTION_ORIGIN !== "string" ||
      !VBTECH_FUNCTION_ORIGIN_PATTERN.test(environment.VBTECH_FUNCTION_ORIGIN)
    )
      throw invalid("VBTECH_FUNCTION_ORIGIN");
    let functionOrigin;
    try {
      functionOrigin = new URL(environment.VBTECH_FUNCTION_ORIGIN);
    } catch {
      throw invalid("VBTECH_FUNCTION_ORIGIN");
    }
    if (
      functionOrigin.protocol !== "https:" ||
      functionOrigin.hostname !== "functions.yandexcloud.net" ||
      functionOrigin.port ||
      functionOrigin.username ||
      functionOrigin.password ||
      functionOrigin.search ||
      functionOrigin.hash ||
      !/^\/[A-Za-z0-9_-]+$/.test(functionOrigin.pathname)
    )
      throw invalid("VBTECH_FUNCTION_ORIGIN");
    return functionOrigin;
  };
  let functionPath = "";
  if (submissionState === "enabled") functionPath = parseFunctionOrigin().pathname;
  else if (environment.VBTECH_FUNCTION_ORIGIN !== undefined) parseFunctionOrigin();

  return {
    imageRef,
    imageDigest: imageMatch[1],
    releaseSha,
    domain,
    wwwDomain,
    functionPath,
    submissionState,
  };
}

function validateKioskOrigin(envText, kioskDomain, httpsPort) {
  const origins = envText
    .split(/\r?\n/)
    .filter((line) => line.startsWith("KIOSK_ORIGIN="))
    .map((line) => line.slice("KIOSK_ORIGIN=".length));
  const port = httpsPort !== undefined && httpsPort !== "443" ? `:${httpsPort}` : "";
  const expectedOrigin = `https://${kioskDomain}${port}`;

  if (origins.length !== 1 || origins[0] !== expectedOrigin)
    throw new Error("KIOSK_ORIGIN does not match MARKIRO_KIOSK_DOMAIN");
}

/**
 * Run quiet Compose validation with a bounded child-process lifetime and output buffer.
 * @param {PreflightEnvironment} environment
 * @param {{
 *   spawn?: typeof spawn,
 *   schedule?: typeof setTimeout,
 *   cancel?: typeof clearTimeout,
 *   timeoutMs?: number,
 *   terminationGraceMs?: number
 * }=} supplied
 */
export async function composeQuiet(environment, supplied = {}) {
  const dependencies = {
    spawn,
    schedule: setTimeout,
    cancel: clearTimeout,
    timeoutMs: COMPOSE_TIMEOUT_MS,
    terminationGraceMs: TERMINATION_GRACE_MS,
    ...supplied,
  };
  const childEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MARKIRO_API_IMAGE_DIGEST: environment.MARKIRO_API_IMAGE_DIGEST,
    MARKIRO_EDGE_IMAGE_DIGEST: environment.MARKIRO_EDGE_IMAGE_DIGEST,
    MARKIRO_DOMAIN: environment.MARKIRO_DOMAIN,
    MARKIRO_KIOSK_DOMAIN: environment.MARKIRO_KIOSK_DOMAIN,
    MARKIRO_LANDING_DOMAIN: environment.MARKIRO_LANDING_DOMAIN,
    MARKIRO_EDGE_MODE: environment.MARKIRO_EDGE_MODE,
    MARKIRO_ENV_FILE: environment.MARKIRO_ENV_FILE,
    MARKIRO_COMPOSE_PROJECT: environment.MARKIRO_COMPOSE_PROJECT,
  };
  if (environment.MARKIRO_IMAGE_TAG !== undefined)
    childEnvironment.MARKIRO_IMAGE_TAG = environment.MARKIRO_IMAGE_TAG;
  if (environment.ACME_EMAIL !== undefined) childEnvironment.ACME_EMAIL = environment.ACME_EMAIL;
  if (environment.MARKIRO_HTTP_PORT !== undefined)
    childEnvironment.MARKIRO_HTTP_PORT = environment.MARKIRO_HTTP_PORT;
  if (environment.MARKIRO_HTTPS_PORT !== undefined)
    childEnvironment.MARKIRO_HTTPS_PORT = environment.MARKIRO_HTTPS_PORT;
  for (const key of [
    "VBTECH_IMAGE_REF",
    "VBTECH_DOMAIN",
    "VBTECH_WWW_DOMAIN",
    "VBTECH_RELEASE_SHA",
    "VBTECH_FUNCTION_PATH",
    "VBTECH_SUBMISSION_STATE",
  ])
    if (environment[key] !== undefined) childEnvironment[key] = environment[key];

  await new Promise((resolve, reject) => {
    let child;
    try {
      child = dependencies.spawn(
        "docker",
        [...productionComposeArgs(environment), "config", "--quiet"],
        { env: childEnvironment, stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch {
      reject(new Error("Compose validation failed"));
      return;
    }

    let deadlineTimer;
    let killTimer;
    let settled = false;
    let timedOut = false;
    let stderr = Buffer.alloc(0);

    const cleanup = () => {
      if (deadlineTimer) dependencies.cancel(deadlineTimer);
      if (killTimer) dependencies.cancel(killTimer);
      child.stderr.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      stderr = Buffer.alloc(0);
    };
    const settle = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const fail = () => settle(new Error("Compose validation failed"));
    const onStderr = (chunk) => {
      const remaining = STDERR_LIMIT_BYTES - stderr.length;
      if (remaining <= 0) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stderr = Buffer.concat([stderr, bytes.subarray(0, remaining)]);
    };
    const onError = () => fail();
    const onClose = (code) => {
      if (timedOut || code !== 0) fail();
      else settle();
    };

    child.stderr.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
    deadlineTimer = dependencies.schedule(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Continue to the bounded hard-kill deadline.
      }
      if (settled) return;
      killTimer = dependencies.schedule(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The stable validation failure below is authoritative.
        }
        fail();
      }, dependencies.terminationGraceMs);
    }, dependencies.timeoutMs);
  });
}

/**
 * @typedef {object} PreflightEnvironment
 * @property {string | undefined} MARKIRO_IMAGE_TAG
 * @property {string | undefined} MARKIRO_API_IMAGE_DIGEST
 * @property {string | undefined} MARKIRO_EDGE_IMAGE_DIGEST
 * @property {string | undefined} MARKIRO_DOMAIN
 * @property {string | undefined} MARKIRO_KIOSK_DOMAIN
 * @property {string | undefined} MARKIRO_LANDING_DOMAIN
 * @property {string | undefined} MARKIRO_EDGE_MODE
 * @property {string | undefined} ACME_EMAIL
 * @property {string | undefined} MARKIRO_ENV_FILE
 * @property {string | undefined} MARKIRO_HTTP_PORT
 * @property {string | undefined} MARKIRO_HTTPS_PORT
 * @property {string | undefined} VBTECH_IMAGE_REF
 * @property {string | undefined} VBTECH_RELEASE_SHA
 * @property {string | undefined} VBTECH_DOMAIN
 * @property {string | undefined} VBTECH_WWW_DOMAIN
 * @property {string | undefined} VBTECH_FUNCTION_ORIGIN
 * @property {string | undefined} VBTECH_SUBMISSION_STATE
 */

/**
 * @typedef {object} PreflightResult
 * @property {string | undefined} imageTag
 * @property {string} apiImageDigest
 * @property {string} edgeImageDigest
 * @property {string} domain
 * @property {string} kioskDomain
 * @property {string} landingDomain
 * @property {string | undefined} acmeEmail
 * @property {string} envFile
 * @property {"direct"} edgeMode
 * @property {string=} vbtechImageRef
 * @property {string=} vbtechImageDigest
 * @property {string=} vbtechReleaseSha
 * @property {string=} vbtechDomain
 * @property {string=} vbtechWwwDomain
 * @property {string=} vbtechFunctionPath
 * @property {"disabled" | "enabled"=} vbtechSubmissionState
 */

/**
 * @param {PreflightEnvironment} environment
 * @param {{
 *   mode(path: string): Promise<number>,
 *   readText(path: string): Promise<string>,
 *   composeQuiet(environment: PreflightEnvironment): Promise<void>
 * }} dependencies
 * @returns {Promise<PreflightResult>}
 */
export async function runPreflight(
  environment,
  dependencies = {
    mode: async (path) => (await stat(path)).mode,
    readText: (path) => readFile(path, "utf8"),
    composeQuiet,
  },
) {
  const imageTag = environment.MARKIRO_IMAGE_TAG;
  const apiImageDigest = environment.MARKIRO_API_IMAGE_DIGEST;
  const edgeImageDigest = environment.MARKIRO_EDGE_IMAGE_DIGEST;
  const domain = environment.MARKIRO_DOMAIN;
  const kioskDomain = environment.MARKIRO_KIOSK_DOMAIN;
  const landingDomain = environment.MARKIRO_LANDING_DOMAIN;
  const edgeMode = environment.MARKIRO_EDGE_MODE || "direct";
  const acmeEmail = environment.ACME_EMAIL;
  const envFile = environment.MARKIRO_ENV_FILE || ".env.production";

  if (!imageTag || !IMAGE_TAG_PATTERN.test(imageTag)) throw invalid("MARKIRO_IMAGE_TAG");
  if (!apiImageDigest || !IMAGE_DIGEST_PATTERN.test(apiImageDigest))
    throw invalid("MARKIRO_API_IMAGE_DIGEST");
  if (!edgeImageDigest || !IMAGE_DIGEST_PATTERN.test(edgeImageDigest))
    throw invalid("MARKIRO_EDGE_IMAGE_DIGEST");
  validateProductionDomains(domain, kioskDomain, landingDomain);
  if (edgeMode !== "direct") throw invalid("MARKIRO_EDGE_MODE");
  const isDirectLocalSet =
    domain === "localhost" &&
    kioskDomain === "kiosk.localhost" &&
    landingDomain === "landing.localhost";
  if (domain === "localhost" && !isDirectLocalSet) throw invalid("MARKIRO_DOMAIN");
  if (kioskDomain === "kiosk.localhost" && !isDirectLocalSet) throw invalid("MARKIRO_KIOSK_DOMAIN");
  if (landingDomain === "landing.localhost" && !isDirectLocalSet)
    throw invalid("MARKIRO_LANDING_DOMAIN");
  const vbtech = parseVbtechConfig(environment, [domain, kioskDomain, landingDomain]);
  if (!acmeEmail || !isEmail(acmeEmail)) throw invalid("ACME_EMAIL");

  try {
    const mode = await dependencies.mode(envFile);
    if ((mode & 0o777) !== 0o600) throw new Error("MARKIRO_ENV_FILE mode must be 0600");
  } catch (error) {
    if (error.message === "MARKIRO_ENV_FILE mode must be 0600") throw error;
    if (error?.code === "ENOENT") throw new Error("MARKIRO_ENV_FILE is missing");
    throw new Error("MARKIRO_ENV_FILE is inaccessible");
  }

  let envText;
  try {
    envText = await dependencies.readText(envFile);
  } catch {
    throw new Error("MARKIRO_ENV_FILE is inaccessible");
  }
  validateKioskOrigin(envText, kioskDomain, environment.MARKIRO_HTTPS_PORT);

  try {
    const composeEnvironment = {
      MARKIRO_IMAGE_TAG: imageTag,
      MARKIRO_API_IMAGE_DIGEST: apiImageDigest,
      MARKIRO_EDGE_IMAGE_DIGEST: edgeImageDigest,
      MARKIRO_DOMAIN: domain,
      MARKIRO_KIOSK_DOMAIN: kioskDomain,
      MARKIRO_LANDING_DOMAIN: landingDomain,
      MARKIRO_EDGE_MODE: edgeMode,
      ACME_EMAIL: acmeEmail,
      MARKIRO_ENV_FILE: envFile,
      MARKIRO_COMPOSE_PROJECT: environment.MARKIRO_COMPOSE_PROJECT,
    };
    if (vbtech) {
      composeEnvironment.VBTECH_IMAGE_REF = vbtech.imageRef;
      composeEnvironment.VBTECH_DOMAIN = vbtech.domain;
      composeEnvironment.VBTECH_WWW_DOMAIN = vbtech.wwwDomain;
      composeEnvironment.VBTECH_RELEASE_SHA = vbtech.releaseSha;
      composeEnvironment.VBTECH_FUNCTION_PATH = vbtech.functionPath;
      composeEnvironment.VBTECH_SUBMISSION_STATE = vbtech.submissionState;
    }
    if (environment.MARKIRO_HTTP_PORT !== undefined)
      composeEnvironment.MARKIRO_HTTP_PORT = environment.MARKIRO_HTTP_PORT;
    if (environment.MARKIRO_HTTPS_PORT !== undefined)
      composeEnvironment.MARKIRO_HTTPS_PORT = environment.MARKIRO_HTTPS_PORT;
    await dependencies.composeQuiet(composeEnvironment);
  } catch {
    throw new Error("Compose validation failed");
  }

  return {
    imageTag,
    apiImageDigest,
    edgeImageDigest,
    domain,
    kioskDomain,
    landingDomain,
    acmeEmail,
    envFile,
    edgeMode,
    ...(vbtech
      ? {
          vbtechImageRef: vbtech.imageRef,
          vbtechImageDigest: vbtech.imageDigest,
          vbtechReleaseSha: vbtech.releaseSha,
          vbtechDomain: vbtech.domain,
          vbtechWwwDomain: vbtech.wwwDomain,
          vbtechFunctionPath: vbtech.functionPath,
          vbtechSubmissionState: vbtech.submissionState,
        }
      : {}),
  };
}

if (isMainModule(import.meta.url)) {
  try {
    await runPreflight(process.env);
    console.log("Production bundle preflight passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
