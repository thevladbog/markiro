import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import { productionComposeArgs } from "./compose-files.mjs";
import { validateProductionDomain } from "./production-domain.mjs";

const IMAGE_TAG_PATTERN = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
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
    MARKIRO_EDGE_MODE: environment.MARKIRO_EDGE_MODE,
    MARKIRO_ENV_FILE: environment.MARKIRO_ENV_FILE,
  };
  if (environment.MARKIRO_IMAGE_TAG !== undefined)
    childEnvironment.MARKIRO_IMAGE_TAG = environment.MARKIRO_IMAGE_TAG;
  if (environment.ACME_EMAIL !== undefined) childEnvironment.ACME_EMAIL = environment.ACME_EMAIL;
  if (environment.MARKIRO_HTTP_PORT !== undefined)
    childEnvironment.MARKIRO_HTTP_PORT = environment.MARKIRO_HTTP_PORT;
  if (environment.MARKIRO_HTTPS_PORT !== undefined)
    childEnvironment.MARKIRO_HTTPS_PORT = environment.MARKIRO_HTTPS_PORT;

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
 * @property {string | undefined} MARKIRO_EDGE_MODE
 * @property {string | undefined} ACME_EMAIL
 * @property {string | undefined} MARKIRO_ENV_FILE
 * @property {string | undefined} MARKIRO_HTTP_PORT
 * @property {string | undefined} MARKIRO_HTTPS_PORT
 */

/**
 * @typedef {object} PreflightResult
 * @property {string | undefined} imageTag
 * @property {string} apiImageDigest
 * @property {string} edgeImageDigest
 * @property {string} domain
 * @property {string | undefined} acmeEmail
 * @property {string} envFile
 * @property {"direct" | "behind-alb"} edgeMode
 */

/**
 * @param {PreflightEnvironment} environment
 * @param {{
 *   mode(path: string): Promise<number>,
 *   composeQuiet(environment: PreflightEnvironment): Promise<void>
 * }} dependencies
 * @returns {Promise<PreflightResult>}
 */
export async function runPreflight(
  environment,
  dependencies = {
    mode: async (path) => (await stat(path)).mode,
    composeQuiet,
  },
) {
  const imageTag = environment.MARKIRO_IMAGE_TAG;
  const apiImageDigest = environment.MARKIRO_API_IMAGE_DIGEST;
  const edgeImageDigest = environment.MARKIRO_EDGE_IMAGE_DIGEST;
  const domain = environment.MARKIRO_DOMAIN;
  const edgeMode = environment.MARKIRO_EDGE_MODE || "direct";
  const acmeEmail = environment.ACME_EMAIL;
  const envFile = environment.MARKIRO_ENV_FILE || ".env.production";

  if (edgeMode === "direct" && (!imageTag || !IMAGE_TAG_PATTERN.test(imageTag)))
    throw invalid("MARKIRO_IMAGE_TAG");
  if (!apiImageDigest || !IMAGE_DIGEST_PATTERN.test(apiImageDigest))
    throw invalid("MARKIRO_API_IMAGE_DIGEST");
  if (!edgeImageDigest || !IMAGE_DIGEST_PATTERN.test(edgeImageDigest))
    throw invalid("MARKIRO_EDGE_IMAGE_DIGEST");
  validateProductionDomain(domain);
  if (edgeMode !== "direct" && edgeMode !== "behind-alb") throw invalid("MARKIRO_EDGE_MODE");
  if (edgeMode === "direct" && (!acmeEmail || !isEmail(acmeEmail))) throw invalid("ACME_EMAIL");

  try {
    const mode = await dependencies.mode(envFile);
    if ((mode & 0o777) !== 0o600) throw new Error("MARKIRO_ENV_FILE mode must be 0600");
  } catch (error) {
    if (error.message === "MARKIRO_ENV_FILE mode must be 0600") throw error;
    if (error?.code === "ENOENT") throw new Error("MARKIRO_ENV_FILE is missing");
    throw new Error("MARKIRO_ENV_FILE is inaccessible");
  }

  try {
    const composeEnvironment = {
      MARKIRO_IMAGE_TAG: imageTag,
      MARKIRO_API_IMAGE_DIGEST: apiImageDigest,
      MARKIRO_EDGE_IMAGE_DIGEST: edgeImageDigest,
      MARKIRO_DOMAIN: domain,
      MARKIRO_EDGE_MODE: edgeMode,
      ACME_EMAIL: acmeEmail,
      MARKIRO_ENV_FILE: envFile,
    };
    if (environment.MARKIRO_HTTP_PORT !== undefined)
      composeEnvironment.MARKIRO_HTTP_PORT = environment.MARKIRO_HTTP_PORT;
    if (environment.MARKIRO_HTTPS_PORT !== undefined)
      composeEnvironment.MARKIRO_HTTPS_PORT = environment.MARKIRO_HTTPS_PORT;
    await dependencies.composeQuiet(composeEnvironment);
  } catch {
    throw new Error("Compose validation failed");
  }

  return { imageTag, apiImageDigest, edgeImageDigest, domain, acmeEmail, envFile, edgeMode };
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
