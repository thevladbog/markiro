/**
 * Fingerprint for visual comparison with the office screen: the first 32 hex
 * characters of the SHA-256, upper-cased, in eight groups of four.
 */
export function formatFingerprint(hex: string): string {
  return (
    hex
      .slice(0, 32)
      .toUpperCase()
      .match(/.{1,4}/g) ?? []
  ).join(" ");
}
