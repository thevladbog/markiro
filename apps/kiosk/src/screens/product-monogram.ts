const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function productMonogram(name: string): string {
  const first = [...name.normalize("NFC")].find((character) => LETTER_OR_DIGIT.test(character));
  if (!first) return "?";
  return [...first.toLocaleUpperCase()][0] ?? "?";
}
