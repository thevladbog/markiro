import { EvidencePackageError } from "./secure-filesystem.mjs";

const MAX_ERROR_BYTES = 320;
const SAFE_CODE = /^[A-Z0-9_]{1,20}$/;

function sanitizeText(value) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s]+/gu, "[path]")
    .replace(/\/(?:[^/\s]+\/)*[^/\s]*/gu, "[path]")
    .replace(/\s+/gu, " ")
    .trim();
}

function truncateUtf8(value, maximumBytes) {
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character);
    if (bytes + width > maximumBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

export function formatCliError(command, error) {
  const safeCommand = truncateUtf8(sanitizeText(command) || "evidence", 48);
  let message;
  if (error instanceof EvidencePackageError) {
    message = sanitizeText(error.message) || "evidence package validation failed";
  } else {
    const code = typeof error?.code === "string" && SAFE_CODE.test(error.code) ? error.code : "";
    message = code ? `filesystem operation failed (${code})` : "filesystem operation failed";
  }
  const prefix = `${safeCommand}: `;
  const available = Math.max(0, MAX_ERROR_BYTES - Buffer.byteLength(prefix) - 1);
  return `${prefix}${truncateUtf8(message, available)}\n`;
}

export async function runCli({
  action,
  args,
  command,
  expectedArgs,
  formatSuccess,
  stderr = process.stderr,
  stdout = process.stdout,
  usage,
}) {
  try {
    const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
    if (normalizedArgs.length !== expectedArgs) throw new EvidencePackageError(usage);
    const result = await action(normalizedArgs);
    if (formatSuccess) stdout.write(formatSuccess(result));
    return 0;
  } catch (error) {
    stderr.write(formatCliError(command, error));
    return 1;
  }
}
