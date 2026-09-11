const NUMBER_PATTERN = /^МКР-(\d{4})-(\d{4,})$/;

/**
 * Allocates the next sequence within a calendar year. Manually typed numbers
 * that do not match the house pattern are ignored rather than parsed
 * defensively — they simply do not take part in the sequence.
 */
export function nextAgreementNumber(existing: readonly string[], year: number): string {
  let highest = 0;
  for (const candidate of existing) {
    const match = NUMBER_PATTERN.exec(candidate);
    if (!match || Number(match[1]) !== year) continue;
    highest = Math.max(highest, Number(match[2]));
  }
  return `МКР-${year}-${String(highest + 1).padStart(4, "0")}`;
}
