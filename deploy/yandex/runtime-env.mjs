import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../production/cli-main.mjs";

const IAM_TOKEN_URL =
  "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token";
const LOCKBOX_PAYLOAD_URL = "https://payload.lockbox.api.cloud.yandex.net/lockbox/v1/secrets";
export const REQUEST_TIMEOUT_MS = 2_000;

const defaultFilesystem = {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  openDirectory(path) {
    return open(path, "r");
  },
};

function invalidInventory() {
  return new Error("runtime environment inventory is invalid");
}

function invalidPayload() {
  return new Error("runtime environment payload is invalid");
}

export function environmentKeysFromExample(source) {
  if (typeof source !== "string") throw invalidInventory();
  const keys = [];
  const seen = new Set();
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0 || /^\s*#/u.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=$/u.exec(line);
    if (!match || seen.has(match[1])) throw invalidInventory();
    seen.add(match[1]);
    keys.push(match[1]);
  }
  if (keys.length === 0) throw invalidInventory();
  return keys;
}

export function renderRuntimeEnvironment(keys, entries) {
  if (!Array.isArray(keys) || !Array.isArray(entries)) throw invalidPayload();
  const expected = new Set(keys);
  if (expected.size !== keys.length || expected.size === 0) throw invalidPayload();

  const values = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.key !== "string" ||
      typeof entry.textValue !== "string" ||
      !expected.has(entry.key) ||
      values.has(entry.key) ||
      /[\r\n]/u.test(entry.textValue)
    )
      throw invalidPayload();
    values.set(entry.key, entry.textValue);
  }
  if (values.size !== expected.size) throw invalidPayload();

  return [...expected]
    .sort()
    .map((key) => `${key}=${values.get(key)}`)
    .join("\n")
    .concat("\n");
}

function boundedFetch(fetch, clock, url, options = {}) {
  return fetch(url, { ...options, signal: clock.timeout(REQUEST_TIMEOUT_MS) });
}

export async function fetchIamToken(
  fetch = globalThis.fetch,
  clock = { timeout: AbortSignal.timeout },
) {
  const response = await boundedFetch(fetch, clock, IAM_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!response.ok) throw new Error("metadata request failed");
  const payload = await response.json();
  if (!payload || typeof payload.access_token !== "string" || payload.access_token.length === 0)
    throw new Error("metadata response is invalid");
  return payload.access_token;
}

export async function fetchSecretPayload(
  secretId,
  iamToken,
  fetch = globalThis.fetch,
  clock = { timeout: AbortSignal.timeout },
) {
  if (typeof secretId !== "string" || secretId.length === 0)
    throw new Error("secret reference is invalid");
  const response = await boundedFetch(
    fetch,
    clock,
    `${LOCKBOX_PAYLOAD_URL}/${encodeURIComponent(secretId)}/payload`,
    {
      headers: { authorization: `Bearer ${iamToken}` },
    },
  );
  if (!response.ok) throw new Error("Lockbox request failed");
  const payload = await response.json();
  if (!payload || !Array.isArray(payload.entries)) throw invalidPayload();
  return payload.entries;
}

async function closeQuietly(handle) {
  if (handle) await handle.close().catch(() => undefined);
}

async function syncDirectory(filesystem, directory) {
  let handle;
  try {
    handle = await filesystem.openDirectory(directory);
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
  } finally {
    await closeQuietly(handle);
  }
}

async function atomicWrite({ destination, filesystem, temporaryPath, text }) {
  const directory = dirname(destination);
  let file;
  try {
    await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
    file = await filesystem.open(temporaryPath, "wx", 0o600);
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await filesystem.chmod(temporaryPath, 0o600);
    await filesystem.rename(temporaryPath, destination);
    await syncDirectory(filesystem, directory);
  } catch (error) {
    await closeQuietly(file);
    await filesystem.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function defaultTemporaryName(destination) {
  return `.${basename(destination)}.${randomUUID()}.tmp`;
}

function asMaterializationFailure() {
  return new Error("runtime environment materialization failed");
}

export async function materializeRuntimeEnv({
  destination = "/etc/markiro/production.env",
  clock = { timeout: AbortSignal.timeout },
  fetch = globalThis.fetch,
  fetchIamToken: loadIamToken = fetchIamToken,
  fetchSecretPayload: loadSecretPayload = fetchSecretPayload,
  fs: filesystem = defaultFilesystem,
  inventoryText,
  secretId,
  temporaryName = defaultTemporaryName,
} = {}) {
  try {
    const keys = environmentKeysFromExample(
      inventoryText ??
        (await filesystem.readFile(
          fileURLToPath(new URL("../../.env.production.example", import.meta.url)),
          "utf8",
        )),
    );
    const iamToken = await loadIamToken(fetch, clock);
    const entries = await loadSecretPayload(secretId, iamToken, fetch, clock);
    const text = renderRuntimeEnvironment(keys, entries);
    const temporaryPath = join(dirname(destination), temporaryName(destination));
    if (dirname(temporaryPath) !== dirname(destination) || temporaryPath === destination)
      throw new Error("temporary destination is invalid");
    await atomicWrite({ destination, filesystem, temporaryPath, text });
  } catch {
    throw asMaterializationFailure();
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await materializeRuntimeEnv({ secretId: process.env.MARKIRO_RUNTIME_SECRET_ID });
  } catch {
    process.stderr.write("runtime environment materialization failed\n");
    process.exitCode = 1;
  }
}
