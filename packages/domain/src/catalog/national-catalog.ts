import { isValidGtin, normalizeToGtin14 } from "../gs1/gtin.js";

export function parseImportGtins(text: string): { gtins: string[]; invalid: string[] } {
  const gtins = new Set<string>();
  const invalid = new Set<string>();

  for (const input of text.split(/[\s,;]+/u).filter(Boolean)) {
    if (isValidGtin(input)) {
      gtins.add(normalizeToGtin14(input));
    } else {
      invalid.add(input);
    }
  }

  return { gtins: [...gtins], invalid: [...invalid] };
}
