import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  LEGAL_RELEASES,
  findLegalDocument,
  legalDocumentKind,
  legalReleaseLocales,
  requireLegalContent,
} from "../src/index.js";

const ASSETS_ROOT = fileURLToPath(new URL("../assets/instructions/", import.meta.url));

const instructionReleases = LEGAL_RELEASES.filter(
  ({ code, status }) => legalDocumentKind(code) === "instruction" && status === "active",
);

describe("instruction assets", () => {
  it("covers at least the first instruction", () => {
    expect(instructionReleases.map(({ code }) => code)).toContain("MKR-INS-01");
  });

  it.each(
    instructionReleases.flatMap(({ code }) =>
      legalReleaseLocales(code).map((locale) => ({ code, locale })),
    ),
  )("keeps $code/$locale content image ids and asset files in sync", ({ code, locale }) => {
    const content = requireLegalContent(findLegalDocument(code), locale);
    const referenced = content.sections
      .flatMap(({ blocks }) => blocks)
      .flatMap((block) => (block.kind === "step" && block.image ? [block.image.id] : []));
    expect(referenced.length).toBeGreaterThan(0);
    expect(new Set(referenced).size).toBe(referenced.length);

    const files = readdirSync(path.join(ASSETS_ROOT, code.toLowerCase(), locale))
      .filter((name) => name.endsWith(".png"))
      .map((name) => name.slice(0, -".png".length));
    expect([...referenced].sort()).toEqual([...files].sort());
  });
});
