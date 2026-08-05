import { execFile } from "node:child_process";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { isMainModule } from "./cli-main.mjs";

const execute = promisify(execFile);
const ALLOWED_UNITS = new Set([
  "docker.service",
  "markiro-compose.service",
  "markiro-deploy.service",
  "markiro-readiness-observer.service",
  "markiro-runner.service",
  "markiro-runner-monitoring.service",
  "markiro-runtime-env.service",
]);

const SENSITIVE_KEY =
  /(?:authorization|password|passwd|secret|token|cookie|api[-_]?key|credential|session)/i;
const MAX_SANITIZER_INPUT_CODE_UNITS = 64 * 1024;
const SIMPLE_ESCAPES = Object.freeze({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" });

function redactText(message) {
  return message
    .replace(/\b(Cookie|Set-Cookie)\s*[:=]\s*.*$/gi, (_match, name) => `${name}: [REDACTED]`)
    .replace(
      /\b(Authorization\s*[:=]\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|(?:Basic|Bearer)\s+\S+|\S+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Basic|Bearer)\s+\S+/gi, "$1 [REDACTED]")
    .replace(
      /\b(authorization|password|passwd|secret|token|cookie|api[-_]?key|credential|session|client_secret|access_token|refresh_token)\s*[:=]\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\S+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+:[^\s/@"']+@/gi, "$1[REDACTED]@")
    .replace(
      /([?&](?:authorization|password|secret|token|api[-_]?key|credential|session|client_secret|access_token|refresh_token)=)[^&#\s"']+/gi,
      "$1[REDACTED]",
    )
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[REDACTED]");
}

function redactStructured(value, depth = 0) {
  if (depth > 20) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactStructured(item, depth + 1));
  if (typeof value === "string") return redactText(value);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactStructured(item, depth + 1),
    ]),
  );
}

function redactJson(message) {
  const trimmed = message.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (hasInvalidUnicodeScalar(parsed)) return "[REDACTED]";
    return JSON.stringify(redactStructured(parsed));
  } catch {
    return undefined;
  }
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (following < 0xdc00 || following > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function hasInvalidUnicodeScalar(value) {
  const pending = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (hasUnpairedSurrogate(item)) return true;
      continue;
    }
    if (!item || typeof item !== "object") continue;
    for (const [key, child] of Object.entries(item)) {
      if (hasUnpairedSurrogate(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

function hexValue(code) {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
  if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
  return -1;
}

function decodeQuotedKey(message, start, end, quote) {
  const decoded = [];
  for (let index = start; index < end; index += 1) {
    const code = message.charCodeAt(index);
    if (code < 0x20) return undefined;
    if (code !== 0x5c) {
      decoded.push(message[index]);
      continue;
    }

    index += 1;
    if (index >= end) return undefined;
    const escaped = message[index];
    if (escaped === "u") {
      if (index + 4 >= end) return undefined;
      let codeUnit = 0;
      for (let offset = 1; offset <= 4; offset += 1) {
        const digit = hexValue(message.charCodeAt(index + offset));
        if (digit < 0) return undefined;
        codeUnit = codeUnit * 16 + digit;
      }
      decoded.push(String.fromCharCode(codeUnit));
      index += 4;
      continue;
    }
    if (escaped === quote || escaped === "\\" || escaped === "/") {
      decoded.push(escaped);
      continue;
    }
    if (quote === "'" && escaped === '"') {
      decoded.push(escaped);
      continue;
    }
    const simple = SIMPLE_ESCAPES[escaped];
    if (simple === undefined) return undefined;
    decoded.push(simple);
  }
  const value = decoded.join("");
  return hasUnpairedSurrogate(value) ? undefined : value;
}

function isAsciiWord(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    code === 0x5f ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function scanQuotedKeys(message, quote) {
  let index = 0;
  while (index < message.length) {
    if (message[index] !== quote) {
      index += 1;
      continue;
    }
    if (
      quote === "'" &&
      isAsciiWord(message.charCodeAt(index - 1)) &&
      isAsciiWord(message.charCodeAt(index + 1))
    ) {
      index += 1;
      continue;
    }

    const start = index + 1;
    let end = start;
    while (end < message.length) {
      if (message[end] === "\\") {
        end += 2;
        continue;
      }
      if (message[end] === quote) break;
      end += 1;
    }
    if (end >= message.length) return false;

    let colon = end + 1;
    while (colon < message.length && (message[colon] === " " || message[colon] === "\t"))
      colon += 1;
    if (message[colon] === ":") {
      const decodedKey = decodeQuotedKey(message, start, end, quote);
      if (decodedKey === undefined || SENSITIVE_KEY.test(decodedKey)) return true;
    }
    index = end + 1;
  }
  return false;
}

function hasUnsafeQuotedKey(message) {
  return scanQuotedKeys(message, '"') || scanQuotedKeys(message, "'");
}

function redact(message) {
  const singleLine = message.replace(/[\r\n]+/g, " ");
  const structured = redactJson(singleLine);
  if (structured !== undefined) return structured;
  if (hasUnsafeQuotedKey(singleLine)) return "[REDACTED]";
  return redactText(singleLine);
}

function truncateUtf8(value, maxBytes) {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 4); end -= 1)
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(encoded.subarray(0, end));
    } catch {
      // Try the preceding UTF-8 boundary.
    }
  return "";
}

export function sanitizeJournal(entries, { maxBytes = 64 * 1024, maxLineBytes = 1024 } = {}) {
  const lines = [];
  let bytes = 0;
  for (const entry of entries.slice(-200)) {
    if (!ALLOWED_UNITS.has(entry?.unit) || typeof entry.message !== "string") continue;
    const prefix = `${entry.unit} `;
    const available = Math.max(0, maxLineBytes - Buffer.byteLength(prefix) - 1);
    const sanitized =
      entry.message.length > MAX_SANITIZER_INPUT_CODE_UNITS ? "[REDACTED]" : redact(entry.message);
    const message = truncateUtf8(sanitized, available);
    const line = `${prefix}${message}\n`;
    if (bytes + Buffer.byteLength(line) > maxBytes) break;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines.join("");
}

async function optionalStat(file) {
  try {
    return await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTimestamp(file) {
  try {
    const value = Number(await readFile(file, "utf8"));
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncPath(file) {
  const handle = await open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableTimestamp(file, timestamp) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${timestamp}\n`, { encoding: "utf8", mode: 0o600 });
  await syncPath(temporary);
  await rename(temporary, file);
  await syncPath(path.dirname(file));
}

export async function writeBoundedSpool(
  spoolPath,
  payload,
  {
    maxBytes = 4 * 1024 * 1024,
    maxAgeMs = 24 * 60 * 60 * 1_000,
    now = Date.now(),
    markerPath = `${spoolPath}.started-at`,
  } = {},
) {
  if (
    typeof spoolPath !== "string" ||
    spoolPath.length === 0 ||
    typeof payload !== "string" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    !Number.isFinite(now) ||
    now < 0
  )
    throw new Error("invalid spool bounds");
  if (Buffer.byteLength(payload) > maxBytes) throw new Error("spool payload exceeds bound");

  const rotatedPath = `${spoolPath}.1`;
  const rotatedMarkerPath = `${rotatedPath}.rotated-at`;
  let active = await optionalStat(spoolPath);
  if (!active) {
    const handle = await open(spoolPath, "a", 0o640);
    await handle.close();
    await syncPath(spoolPath);
    await syncPath(path.dirname(spoolPath));
    active = await stat(spoolPath);
  }

  let startedAt = await readTimestamp(markerPath);
  if (startedAt === undefined) {
    startedAt = active.size === 0 ? now : Math.min(now, active.birthtimeMs || active.ctimeMs);
    await durableTimestamp(markerPath, startedAt);
  }

  const rotated = await optionalStat(rotatedPath);
  if (rotated) {
    const rotatedAt =
      (await readTimestamp(rotatedMarkerPath)) ??
      Math.min(now, rotated.birthtimeMs || rotated.ctimeMs);
    if (now - rotatedAt >= maxAgeMs) {
      await rm(rotatedPath, { force: true });
      await rm(rotatedMarkerPath, { force: true });
      await syncPath(path.dirname(spoolPath));
    } else if ((await readTimestamp(rotatedMarkerPath)) === undefined) {
      await durableTimestamp(rotatedMarkerPath, rotatedAt);
    }
  } else {
    await rm(rotatedMarkerPath, { force: true });
  }

  const shouldRotate =
    active.size > 0 &&
    (active.size + Buffer.byteLength(payload) > maxBytes || now - startedAt >= maxAgeMs);
  if (shouldRotate) {
    await rm(rotatedPath, { force: true });
    await rm(rotatedMarkerPath, { force: true });
    await rename(spoolPath, rotatedPath);
    await durableTimestamp(rotatedMarkerPath, now);
    const handle = await open(spoolPath, "a", 0o640);
    await handle.close();
    await syncPath(spoolPath);
    await durableTimestamp(markerPath, now);
    await syncPath(path.dirname(spoolPath));
  }

  if (payload) {
    const handle = await open(spoolPath, "a", 0o640);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function runCli() {
  const { stdout } = await execute(
    "journalctl",
    [
      "--since=-5min",
      "--lines=200",
      "--output=json",
      "--no-pager",
      ...[...ALLOWED_UNITS].flatMap((unit) => ["--unit", unit]),
    ],
    { maxBuffer: 512 * 1024 },
  );
  const entries = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return [{ unit: parsed._SYSTEMD_UNIT, message: parsed.MESSAGE }];
      } catch {
        return [];
      }
    });
  await writeBoundedSpool("/var/log/markiro/observability.log", sanitizeJournal(entries));
}

if (isMainModule(import.meta.url))
  runCli().catch(() => {
    process.stderr.write("journal sanitization failed\n");
    process.exitCode = 1;
  });
