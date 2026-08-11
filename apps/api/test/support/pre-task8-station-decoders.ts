/**
 * Frozen top-level compatibility checks copied from the station decoders at
 * 415c07cd^, before Task 8 added subscription state. Keep these strict: the
 * rolling-upgrade contract is that a client sending no capability sees the
 * exact legacy envelope, not merely an envelope old clients might ignore.
 */
function exactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function preTask8PairDecoderAccepts(value: unknown): boolean {
  return exactRecord(value, ["device", "credential", "operators"]);
}

export function preTask8IdentityDecoderAccepts(value: unknown): boolean {
  return exactRecord(value, ["device"]);
}
