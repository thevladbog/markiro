import { DomainError } from "../../errors.js";

/** Entry normalization only. Stored snapshots and exports must preserve their value. */
export function normalizeTlc(raw: string): string {
  // Check before trim so a scanner separator or line break is never silently removed.
  if (/[\p{Cc}\p{Cs}]/u.test(raw)) {
    throw new DomainError(
      "TLC_INVALID",
      "A TLC cannot contain control or invalid Unicode characters.",
    );
  }
  const value = raw.trim();
  const length = [...value].length;
  if (length < 1 || length > 120) {
    throw new DomainError("TLC_INVALID", "A TLC must contain 1–120 characters.");
  }
  return value;
}

/** Synthetic suggestion only: no assignment, persistence or uniqueness guarantee. */
export function formatDemoTlc(input: { prefix: string; date: string; suffix: string }): string {
  const { prefix, date, suffix } = input;
  if (
    !/^[A-Z0-9]{1,12}$/.test(prefix) ||
    !/^[A-Z0-9]{1,24}$/.test(suffix) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date.startsWith("0000-")
  ) {
    throw new DomainError(
      "DEMO_TLC_INVALID",
      "Expected demo code components and an ISO civil date.",
    );
  }
  const instant = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString().slice(0, 10) !== date) {
    throw new DomainError("DEMO_TLC_INVALID", "Expected a valid ISO civil date.");
  }
  return `${prefix}-${date.slice(2, 4)}${date.slice(5, 7)}${date.slice(8, 10)}-${suffix}`;
}
