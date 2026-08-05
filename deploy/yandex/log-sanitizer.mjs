import { appendFile } from "node:fs/promises";
import { execFile } from "node:child_process";
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

function redact(message) {
  return message
    .replace(/\b(authorization|password|secret|token)=\S+/gi, "$1=[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[REDACTED]");
}

export function sanitizeJournal(entries, { maxBytes = 64 * 1024, maxLineBytes = 1024 } = {}) {
  const lines = [];
  let bytes = 0;
  for (const entry of entries.slice(-200)) {
    if (!ALLOWED_UNITS.has(entry?.unit) || typeof entry.message !== "string") continue;
    const prefix = `${entry.unit} `;
    const available = Math.max(0, maxLineBytes - Buffer.byteLength(prefix) - 1);
    const message = Buffer.from(redact(entry.message), "utf8")
      .subarray(0, available)
      .toString("utf8");
    const line = `${prefix}${message}\n`;
    if (bytes + Buffer.byteLength(line) > maxBytes) break;
    lines.push(line);
    bytes += Buffer.byteLength(line);
  }
  return lines.join("");
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
  const sanitized = sanitizeJournal(entries);
  if (sanitized)
    await appendFile("/var/log/markiro/observability.log", sanitized, {
      encoding: "utf8",
      mode: 0o640,
    });
}

if (isMainModule(import.meta.url))
  runCli().catch(() => {
    process.stderr.write("journal sanitization failed\n");
    process.exitCode = 1;
  });
