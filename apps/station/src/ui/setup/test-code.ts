/**
 * Alphabet for hardware test codes: digits and capitals minus the confusable
 * glyphs (0/O, 1/I/L, 5/S, 6/G, U/V, Z/2). The operator compares the printed
 * caption with what the verdict line echoes back, so every character must be
 * unmistakable at a glance on a workshop floor.
 */
const ALPHABET = "34789ACDEFHKMNPRTWXY";

/**
 * A fresh code for a scanner or printer check, e.g. «MKR-7Q4F2N». Random so
 * a stale scan buffered from a previous check (or an operator scanning an old
 * printed test label) can never produce a false «works correctly».
 */
export function makeSetupTestCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let tail = "";
  for (const byte of bytes) tail += ALPHABET[byte % ALPHABET.length];
  return `MKR-${tail}`;
}

/** The verdict of one check: what arrived, and whether it was the expected code. */
export interface SetupCheckResult {
  ok: boolean;
  received: string;
}
