import { BadRequestException } from "@nestjs/common";

export const MAX_IMPORT_LINES = 10_000;

/** Digits-and-separators text → raw tokens. Encoding-agnostic on purpose. */
export function parseSsccImport(text: string): string[] {
  const tokens = text
    .split(/[\r\n;,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length > MAX_IMPORT_LINES) {
    throw new BadRequestException({ code: "too_many_lines", max: MAX_IMPORT_LINES });
  }
  return tokens;
}
