/**
 * Plan 04 Task 5: admin canvas rasterizer + Cyrillic font coverage check.
 *
 * Split into two concerns per the plan brief:
 *
 * 1. `rasterizeText` (labels/rasterizer.ts) needs a real browser `<canvas>`
 *    2D context, which jsdom does not provide (jsdom's own
 *    `HTMLCanvasElement.prototype.getContext` returns `null` unless the
 *    optional native `canvas` npm package is installed -- it is
 *    deliberately NOT a dependency here). So the only thing pinned under
 *    this suite is the typed `RasterUnavailableError` jsdom throws --
 *    exactly Idento's `canvasRasterizer.ts` pattern.
 * 2. `fontCoverage.ts`'s cmap-walk decision logic needs no canvas at all and
 *    is fully unit-testable. Feasibility check (see that module's doc
 *    comment): `opentype.js@2.0.0` ships `Font`/`Glyph` constructors AND
 *    `Font.prototype.toArrayBuffer()`, so a synthetic font can be built with
 *    the real API, serialized to genuine sfnt bytes, and fed back through
 *    `opentype.parse()` -- a full non-mocked round-trip. No font binary is
 *    vendored into the repo (quarantine/HARD RULES forbid that); every font
 *    used below is generated in-memory by the test itself.
 */
import { Font, Glyph } from "opentype.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkCyrillicCoverage,
  checkFamilyCoverage,
  CYRILLIC_SAMPLE,
  sampleCoveredByFont,
} from "../src/labels/fontCoverage.js";
import { RasterUnavailableError, rasterizeText } from "../src/labels/rasterizer.js";

/**
 * Builds a minimal, real, serializable `opentype.Font` whose glyph set is
 * exactly `.notdef` plus one glyph per character in `chars` -- enough to
 * drive `charToGlyphIndex` (via `DefaultEncoding` in-memory, or via a real
 * cmap table once round-tripped through `toArrayBuffer`/`parse`) without
 * any actual outlines, hinting, or real typography.
 */
function buildSyntheticFont(chars: readonly string[]): Font {
  const glyphs = [new Glyph({ name: ".notdef", advanceWidth: 500 })];
  for (const ch of chars) {
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) continue;
    glyphs.push(new Glyph({ name: `g${codePoint}`, unicode: codePoint, advanceWidth: 500 }));
  }
  return new Font({
    familyName: "MarkiroSyntheticTestFont",
    styleName: "Regular",
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs,
  });
}

describe("rasterizeText (browser canvas rasterizer)", () => {
  it("throws RasterUnavailableError under jsdom, which has no real canvas 2D context", async () => {
    await expect(
      rasterizeText("Привет", { fontFamily: "IBM Plex Sans", fontSizePx: 16, bold: false }),
    ).rejects.toBeInstanceOf(RasterUnavailableError);
  });

  it("names the thrown error RasterUnavailableError (typed, not a generic Error)", async () => {
    await rasterizeText("x", { fontFamily: "IBM Plex Sans", fontSizePx: 16, bold: false }).catch(
      (err: unknown) => {
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).name).toBe("RasterUnavailableError");
      },
    );
  });
});

describe("sampleCoveredByFont (pure cmap-walk decision logic)", () => {
  it("is true when the font has a glyph for every sample character", () => {
    const font = buildSyntheticFont([...CYRILLIC_SAMPLE]);
    expect(sampleCoveredByFont(font)).toBe(true);
  });

  it("is false when even one sample character has no glyph", () => {
    const withoutYo = [...CYRILLIC_SAMPLE].filter((ch) => ch !== "ё");
    const font = buildSyntheticFont(withoutYo);
    expect(sampleCoveredByFont(font)).toBe(false);
  });

  it("is false for a font with no glyphs at all", () => {
    const font = buildSyntheticFont([]);
    expect(sampleCoveredByFont(font)).toBe(false);
  });
});

describe("checkCyrillicCoverage (parse + sample check, real opentype.js round-trip)", () => {
  it("returns true for real sfnt bytes serialized from a full-coverage synthetic font", () => {
    const fontBytes = buildSyntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer();
    expect(checkCyrillicCoverage(fontBytes)).toBe(true);
  });

  it("returns false for real sfnt bytes serialized from a partial-coverage synthetic font", () => {
    const missingZhe = [...CYRILLIC_SAMPLE].filter((ch) => ch !== "Ж");
    const fontBytes = buildSyntheticFont(missingZhe).toArrayBuffer();
    expect(checkCyrillicCoverage(fontBytes)).toBe(false);
  });

  it("returns false for a font covering only Latin text (no Cyrillic glyphs)", () => {
    const fontBytes = buildSyntheticFont(["A", "B", "C"]).toArrayBuffer();
    expect(checkCyrillicCoverage(fontBytes)).toBe(false);
  });
});

describe("checkFamilyCoverage (subset-union policy)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetchSequence(buffers: readonly ArrayBuffer[]) {
    // `callIndex` is captured synchronously inside the mock body itself
    // (not read lazily from `fetchMock.mock.calls.length` inside the
    // nested `arrayBuffer` closure below) because `checkFamilyCoverage`
    // fires both `fetch()` calls back-to-back via `Promise.all` before
    // either `.arrayBuffer()` resolves -- reading the mock's call count
    // lazily would race and both closures would see the final count.
    let callIndex = 0;
    const fetchMock = vi.fn(async () => {
      const buffer = buffers[callIndex];
      callIndex += 1;
      return { arrayBuffer: async () => buffer };
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("passes when only the SECOND fetched subset (simulating the cyrillic file) covers the sample", async () => {
    const noCoverage = buildSyntheticFont(["A", "B"]).toArrayBuffer();
    const fullCoverage = buildSyntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer();
    const fetchMock = stubFetchSequence([noCoverage, fullCoverage]);

    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(true);
    // Both subset files are fetched (latin AND cyrillic), regardless of
    // which one ends up satisfying the union -- the "fetch BOTH" half of
    // the documented policy, not just the "ANY passes" half.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes when only the FIRST fetched subset covers the sample", async () => {
    const fullCoverage = buildSyntheticFont([...CYRILLIC_SAMPLE]).toArrayBuffer();
    const noCoverage = buildSyntheticFont(["A", "B"]).toArrayBuffer();
    stubFetchSequence([fullCoverage, noCoverage]);

    await expect(checkFamilyCoverage("IBM Plex Mono")).resolves.toBe(true);
  });

  it("fails only when NEITHER fetched subset covers the sample", async () => {
    const noCoverageA = buildSyntheticFont(["A", "B"]).toArrayBuffer();
    const noCoverageB = buildSyntheticFont(["C", "D"]).toArrayBuffer();
    stubFetchSequence([noCoverageA, noCoverageB]);

    await expect(checkFamilyCoverage("IBM Plex Sans")).resolves.toBe(false);
  });
});
