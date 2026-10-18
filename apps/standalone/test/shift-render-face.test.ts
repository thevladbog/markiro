import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildDefaultLabelTemplates, sampleLabelData, type RasterizeTextFn } from "@markiro/domain";

import { shiftLabelRender } from "../src/floor/print/shift-render.js";
import * as Rasterizer from "../src/labels/rasterizer.js";
import { workShift } from "./support/floor-work.js";

// The app's own rasterizers, replaced by spies that draw a blank line: the
// tests see which one a shift's render hands the label (plan ДРВ: a driver
// page only from the bundled face; a RAW label the best-effort one).
vi.mock("../src/labels/rasterizer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Rasterizer>();
  const blank: RasterizeTextFn = async (_text, options) => {
    const width = Math.max(1, Math.min(8, options.maxWidthPx ?? 8));
    const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
    return { width, height, bytesPerRow: 1, totalBytes: height, hex: "00".repeat(height) };
  };
  return {
    ...actual,
    rasterizeText: vi.fn(blank),
    rasterizeDriverText: vi.fn(blank),
  };
});

/** A stock layout without a logo box: no logo is loaded, only text is drawn. */
function plainLayout() {
  const template = buildDefaultLabelTemplates().find(
    (each) => !each.spec.elements.some((element) => element.kind === "organization_logo"),
  );
  if (template === undefined) throw new Error("every stock layout has a logo box");
  return template.spec;
}

const DRIVER = { language: "zpl", dpi: 203, mode: "windows_driver" } as const;
const RAW = { language: "zpl", dpi: 203 } as const;

describe("shiftLabelRender: the rasterizer of the app's own render", () => {
  beforeEach(() => {
    vi.mocked(Rasterizer.rasterizeText).mockClear();
    vi.mocked(Rasterizer.rasterizeDriverText).mockClear();
  });

  it("draws a driver page with the bundled face only, never the best-effort one", async () => {
    const shift = await workShift(null);
    await shiftLabelRender(shift, { loadLogo: async () => null })(
      plainLayout(),
      sampleLabelData(),
      DRIVER,
    );
    expect(Rasterizer.rasterizeDriverText).toHaveBeenCalled();
    expect(Rasterizer.rasterizeText).not.toHaveBeenCalled();
  });

  it("refuses a driver page when the bundled face is unavailable, rather than freezing a fallback", async () => {
    const shift = await workShift(null);
    vi.mocked(Rasterizer.rasterizeDriverText).mockRejectedValueOnce(
      new Rasterizer.RasterUnavailableError("The bundled label font is unavailable"),
    );
    await expect(
      shiftLabelRender(shift, { loadLogo: async () => null })(
        plainLayout(),
        sampleLabelData(),
        DRIVER,
      ),
    ).rejects.toBeInstanceOf(Rasterizer.RasterUnavailableError);
    expect(Rasterizer.rasterizeText).not.toHaveBeenCalled();
  });

  it("draws a RAW label with the best-effort rasterizer, as before", async () => {
    const shift = await workShift(null);
    await shiftLabelRender(shift, { loadLogo: async () => null })(
      plainLayout(),
      sampleLabelData(),
      RAW,
    );
    expect(Rasterizer.rasterizeText).toHaveBeenCalled();
    expect(Rasterizer.rasterizeDriverText).not.toHaveBeenCalled();
  });

  it("hands a rasterizer the caller gives to either path unchanged", async () => {
    const shift = await workShift(null);
    const own = vi.fn<RasterizeTextFn>(async (_text, options) => {
      const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
      return { width: 1, height, bytesPerRow: 1, totalBytes: height, hex: "00".repeat(height) };
    });
    const render = shiftLabelRender(shift, { rasterize: own, loadLogo: async () => null });
    await render(plainLayout(), sampleLabelData(), DRIVER);
    await render(plainLayout(), sampleLabelData(), RAW);
    expect(own).toHaveBeenCalled();
    expect(Rasterizer.rasterizeText).not.toHaveBeenCalled();
    expect(Rasterizer.rasterizeDriverText).not.toHaveBeenCalled();
  });
});
