// Bounded, secret-free diagnostic for a failed public smoke.
//
// The only producer is smoke.mjs: its entry points call `recordSmokeDiagnostic`, which
// registers a sanitized one-line cause for the thrown error object. Consumers (the hosted
// wrapper, deploy.mjs) read it back with `smokeDiagnosticOf`. An error that smoke.mjs did
// not record has no diagnostic by construction, so no other stage (transfer, prepare,
// registry, ssh, rollback...) can ever reach the log through this channel.
//
// Messages that smoke.mjs builds are constant strings, fixed route paths, and public
// authority origins. Defence in depth: anything that is not short printable ASCII, or
// that looks like a credential, is replaced by a fixed placeholder.

export const SMOKE_DIAGNOSTIC_MAX_LENGTH = 200;
export const SMOKE_DIAGNOSTIC_WITHHELD = "message withheld";
export const SMOKE_FAILURE_MARKER = "MARKIRO_SMOKE_FAILURE";

const PRINTABLE_ASCII_LINE = /^[\x20-\x7E]+$/;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:token|secret|passw(?:or)?d|api[-_ ]?key|authorization|bearer|cookie)\b/i;
const LONG_OPAQUE_RUN = /[A-Za-z0-9_-]{32,}/;
const ERROR_NAME = /^[A-Za-z]{1,40}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,39}$/;

const diagnostics = new WeakMap();

/** @returns {string | undefined} the message when it is safe to print, otherwise undefined. */
export function sanitizeSmokeMessage(message) {
  if (typeof message !== "string") return undefined;
  if (message.length === 0 || message.length > SMOKE_DIAGNOSTIC_MAX_LENGTH) return undefined;
  if (!PRINTABLE_ASCII_LINE.test(message)) return undefined;
  if (CREDENTIAL_ASSIGNMENT.test(message) || LONG_OPAQUE_RUN.test(message)) return undefined;
  return message;
}

function describe(error) {
  const parts = [sanitizeSmokeMessage(error?.message) ?? SMOKE_DIAGNOSTIC_WITHHELD];
  const name = error?.name;
  if (typeof name === "string" && name !== "Error" && ERROR_NAME.test(name))
    parts.push(`name=${name}`);
  const code = error?.cause?.code ?? error?.code;
  if (typeof code === "string" && ERROR_CODE.test(code)) parts.push(`code=${code}`);
  const causeName = error?.cause?.name;
  if (typeof causeName === "string" && causeName !== "Error" && ERROR_NAME.test(causeName))
    parts.push(`cause=${causeName}`);
  const line = parts.join(" ");
  return line.length <= SMOKE_DIAGNOSTIC_MAX_LENGTH ? line : SMOKE_DIAGNOSTIC_WITHHELD;
}

/** Called by smoke.mjs only. Records the diagnostic once and returns the same error. */
export function recordSmokeDiagnostic(error) {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    if (!diagnostics.has(error)) diagnostics.set(error, describe(error));
  }
  return error;
}

/** @returns {string | undefined} */
export function smokeDiagnosticOf(error) {
  return typeof error === "object" && error !== null ? diagnostics.get(error) : undefined;
}

/** One stderr line, or the empty string when the error carries no smoke diagnostic. */
export function smokeFailureLine(error) {
  const diagnostic = smokeDiagnosticOf(error);
  return diagnostic === undefined ? "" : `${SMOKE_FAILURE_MARKER} ${diagnostic}\n`;
}
