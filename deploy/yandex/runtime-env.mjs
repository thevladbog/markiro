import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { isMainModule } from "./cli-main.mjs";

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
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue;
    const match = /^([A-Z][A-Z0-9_]*)=$/u.exec(line);
    if (!match || seen.has(match[1])) throw invalidInventory();
    seen.add(match[1]);
    keys.push(match[1]);
  }
  if (keys.length === 0) throw invalidInventory();
  return keys;
}

export function runtimeInventoryKeyNames(keys, entries) {
  if (!Array.isArray(keys) || !Array.isArray(entries)) throw invalidInventory();
  const expected = new Set();
  for (const key of keys) {
    if (typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/u.test(key) || expected.has(key))
      throw invalidInventory();
    expected.add(key);
  }
  if (expected.size === 0) throw invalidInventory();

  const received = new Set();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.key !== "string" ||
      !/^[A-Z][A-Z0-9_]*$/u.test(entry.key) ||
      typeof entry.textValue !== "string" ||
      !expected.has(entry.key) ||
      received.has(entry.key)
    )
      throw invalidInventory();
    received.add(entry.key);
  }
  if (received.size !== expected.size) throw invalidInventory();

  return Object.freeze([...expected].sort());
}

export function renderRuntimeEnvironment(keys, entries) {
  let keyNames;
  try {
    keyNames = runtimeInventoryKeyNames(keys, entries);
  } catch {
    throw invalidPayload();
  }

  const values = new Map();
  for (const entry of entries) {
    if (/[\r\n]/u.test(entry.textValue)) throw invalidPayload();
    values.set(entry.key, entry.textValue);
  }

  return keyNames
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

export async function verifyRuntimeInventory({
  clock = { timeout: AbortSignal.timeout },
  fetch = globalThis.fetch,
  fetchIamToken: loadIamToken = fetchIamToken,
  fetchSecretPayload: loadSecretPayload = fetchSecretPayload,
  inventoryText,
  secretId,
} = {}) {
  try {
    if (typeof secretId !== "string" || secretId.length === 0) throw invalidInventory();
    const keys = environmentKeysFromExample(inventoryText);
    const iamToken = await loadIamToken(fetch, clock);
    const entries = await loadSecretPayload(secretId, iamToken, fetch, clock);
    return runtimeInventoryKeyNames(keys, entries);
  } catch {
    throw invalidInventory();
  }
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

function warnDurability(onWarning) {
  try {
    onWarning("runtime environment durability is indeterminate");
  } catch {
    // The durable replacement has already committed; warnings cannot roll it back.
  }
}

async function atomicWrite({ destination, filesystem, onWarning, temporaryPath, text }) {
  const directory = dirname(destination);
  let file;
  let renamed = false;
  try {
    await filesystem.mkdir(directory, { recursive: true, mode: 0o700 });
    file = await filesystem.open(temporaryPath, "wx", 0o600);
    await file.writeFile(text, "utf8");
    await file.sync();
    await file.close();
    file = undefined;
    await filesystem.chmod(temporaryPath, 0o600);
    await filesystem.rename(temporaryPath, destination);
    renamed = true;
    try {
      await syncDirectory(filesystem, directory);
    } catch {
      warnDurability(onWarning);
    }
  } catch (error) {
    await closeQuietly(file);
    if (!renamed) await filesystem.unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function defaultTemporaryName(destination) {
  return `.${basename(destination)}.${randomUUID()}.tmp`;
}

function asMaterializationFailure() {
  return new Error("runtime environment materialization failed");
}

const CLI_FAILURE = "runtime environment materialization failed";
const CLI_DURABILITY_WARNING = "runtime environment durability is indeterminate";
const INVENTORY_CLI_FAILURE = "runtime environment inventory is invalid";

function writeSanitizedLine(stderr, line) {
  try {
    stderr.write(`${line}\n`);
  } catch {
    // Logging failure cannot change the committed replacement outcome.
  }
}

export async function materializeRuntimeEnv({
  destination = "/etc/markiro/production.env",
  clock = { timeout: AbortSignal.timeout },
  fetch = globalThis.fetch,
  fetchIamToken: loadIamToken = fetchIamToken,
  fetchSecretPayload: loadSecretPayload = fetchSecretPayload,
  fs: filesystem = defaultFilesystem,
  inventoryText,
  onWarning = () => undefined,
  secretId,
  temporaryName = defaultTemporaryName,
} = {}) {
  try {
    const keys = environmentKeysFromExample(
      inventoryText ??
        (await filesystem.readFile(
          fileURLToPath(new URL("./.env.production.example", import.meta.url)),
          "utf8",
        )),
    );
    const iamToken = await loadIamToken(fetch, clock);
    const entries = await loadSecretPayload(secretId, iamToken, fetch, clock);
    const text = renderRuntimeEnvironment(keys, entries);
    const temporaryPath = join(dirname(destination), temporaryName(destination));
    if (dirname(temporaryPath) !== dirname(destination) || temporaryPath === destination)
      throw new Error("temporary destination is invalid");
    await atomicWrite({ destination, filesystem, onWarning, temporaryPath, text });
  } catch {
    throw asMaterializationFailure();
  }
}

export async function runInventoryCli({
  environment = process.env,
  inventoryPath,
  readInventory = readFile,
  stderr = process.stderr,
  verify = verifyRuntimeInventory,
  ...dependencies
} = {}) {
  try {
    if (typeof inventoryPath !== "string" || !isAbsolute(inventoryPath)) throw invalidInventory();
    const inventoryText = await readInventory(inventoryPath, "utf8");
    await verify({
      ...dependencies,
      inventoryText,
      secretId: environment.MARKIRO_RUNTIME_SECRET_ID,
    });
    return 0;
  } catch {
    writeSanitizedLine(stderr, INVENTORY_CLI_FAILURE);
    return 1;
  }
}

export async function runCli({
  argv = [],
  environment = process.env,
  inventoryCli = runInventoryCli,
  materialize = materializeRuntimeEnv,
  stderr = process.stderr,
  ...dependencies
} = {}) {
  if (argv.length !== 0) {
    if (
      argv.length !== 2 ||
      argv[0] !== "verify-inventory" ||
      typeof argv[1] !== "string" ||
      !isAbsolute(argv[1])
    ) {
      writeSanitizedLine(stderr, INVENTORY_CLI_FAILURE);
      return 1;
    }
    return inventoryCli({
      ...dependencies,
      environment,
      inventoryPath: argv[1],
      stderr,
    });
  }
  try {
    await materialize({
      ...dependencies,
      onWarning: () => writeSanitizedLine(stderr, CLI_DURABILITY_WARNING),
      secretId: environment.MARKIRO_RUNTIME_SECRET_ID,
    });
    return 0;
  } catch {
    writeSanitizedLine(stderr, CLI_FAILURE);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runCli({ argv: process.argv.slice(2) });
}
