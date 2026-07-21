/** GS1 mod-10 check digit for a numeric body (GTIN/SSCC/GLN families). */
export function gs1CheckDigit(body: string): number {
  if (body.length === 0 || !/^\d+$/.test(body)) {
    throw new RangeError(`GS1 check digit input must be 1+ digits, got "${body}"`);
  }
  let sum = 0;
  // Rightmost body digit carries weight 3, alternating leftwards.
  for (let i = 0; i < body.length; i++) {
    const digit = body.charCodeAt(body.length - 1 - i) - 48;
    sum += i % 2 === 0 ? digit * 3 : digit;
  }
  return (10 - (sum % 10)) % 10;
}

/** Validates a complete GS1 code whose last digit is the check digit. */
export function hasValidCheckDigit(code: string): boolean {
  if (code.length < 2 || !/^\d+$/.test(code)) return false;
  return gs1CheckDigit(code.slice(0, -1)) === Number(code.at(-1));
}
