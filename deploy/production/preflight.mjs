import { stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import process from "node:process";

const IMAGE_TAG_PATTERN = /^[0-9a-f]{40}$/;
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isEmail(value) {
  const at = value.indexOf("@");
  return at > 0 && at === value.lastIndexOf("@") && at < value.length - 1;
}

function invalid(variable) {
  return new Error(`${variable} is invalid`);
}

async function composeQuiet(environment) {
  const childEnvironment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    MARKIRO_IMAGE_TAG: environment.MARKIRO_IMAGE_TAG,
    MARKIRO_DOMAIN: environment.MARKIRO_DOMAIN,
    ACME_EMAIL: environment.ACME_EMAIL,
    MARKIRO_ENV_FILE: environment.MARKIRO_ENV_FILE,
  };

  await new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "compose",
        "--env-file",
        environment.MARKIRO_ENV_FILE,
        "-f",
        "compose.production.yml",
        "config",
        "--quiet",
      ],
      { env: childEnvironment, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr));
    });
  });
}

/**
 * @typedef {Record<string, string | undefined>} PreflightEnvironment
 */

/**
 * @typedef {object} PreflightResult
 * @property {string} imageTag
 * @property {string} domain
 * @property {string} acmeEmail
 * @property {string} envFile
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
  const domain = environment.MARKIRO_DOMAIN;
  const acmeEmail = environment.ACME_EMAIL;
  const envFile = environment.MARKIRO_ENV_FILE || ".env.production";

  if (!imageTag || !IMAGE_TAG_PATTERN.test(imageTag)) throw invalid("MARKIRO_IMAGE_TAG");
  if (!domain || !DOMAIN_PATTERN.test(domain)) throw invalid("MARKIRO_DOMAIN");
  if (!acmeEmail || !isEmail(acmeEmail)) throw invalid("ACME_EMAIL");

  try {
    const mode = await dependencies.mode(envFile);
    if ((mode & 0o777) !== 0o600) throw new Error("MARKIRO_ENV_FILE mode must be 0600");
  } catch (error) {
    if (error.message === "MARKIRO_ENV_FILE mode must be 0600") throw error;
    if (error?.code === "ENOENT") throw new Error("MARKIRO_ENV_FILE is missing");
    throw new Error("MARKIRO_ENV_FILE is inaccessible");
  }

  try {
    await dependencies.composeQuiet({
      MARKIRO_IMAGE_TAG: imageTag,
      MARKIRO_DOMAIN: domain,
      ACME_EMAIL: acmeEmail,
      MARKIRO_ENV_FILE: envFile,
    });
  } catch {
    throw new Error("Compose validation failed");
  }

  return { imageTag, domain, acmeEmail, envFile };
}

if (import.meta.main) {
  try {
    await runPreflight(process.env);
    console.log("Production bundle preflight passed");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
