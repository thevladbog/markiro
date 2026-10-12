import { describe, expect, it, vi } from "vitest";

import {
  buildDefaultLabelTemplates,
  sampleLabelData,
  type MonoBitmap,
  type RasterizeTextFn,
} from "@markiro/domain";

import { renderLabel } from "../src/floor/print/label-render.js";
import { shiftLabelRender, LOGO_UNAVAILABLE_LINE } from "../src/floor/print/shift-render.js";
import { workShift } from "./support/floor-work.js";

const LOGO: MonoBitmap = {
  width: 16,
  height: 8,
  stride: 2,
  pixels: new Uint8Array(16).fill(0xff),
};
const MARKIRO: MonoBitmap = {
  width: 8,
  height: 2,
  stride: 1,
  pixels: new Uint8Array([0xf0, 0x0f]),
};

const blankText: RasterizeTextFn = async (_text, options) => {
  const width = Math.max(1, Math.min(8, options.maxWidthPx ?? 8));
  const height = Math.ceil(options.fontSizePx * (options.lineHeight ?? 1.5));
  return { width, height, bytesPerRow: 1, totalBytes: height, hex: "00".repeat(height) };
};

function decode(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return text;
}

/** A stock layout that reserves an `organization_logo` box (#703). */
function logoLayout() {
  const template = buildDefaultLabelTemplates().find((each) =>
    each.spec.elements.some((element) => element.kind === "organization_logo"),
  );
  if (template === undefined) throw new Error("no stock layout with a logo box");
  return template.spec;
}

/** A stock layout without a logo box. */
function plainLayout() {
  const template = buildDefaultLabelTemplates().find(
    (each) => !each.spec.elements.some((element) => element.kind === "organization_logo"),
  );
  if (template === undefined) throw new Error("every stock layout has a logo box");
  return template.spec;
}

const ZPL_203 = { language: "zpl", dpi: 203 } as const;

describe("shiftLabelRender", () => {
  it("prints the logo the shift froze", async () => {
    const shift = await workShift({ name: "ООО «Пример»", inn: null, logo: LOGO });
    const loadLogo = vi.fn(async (own: MonoBitmap | null) => own);
    const render = shiftLabelRender(shift, { rasterize: blankText, loadLogo });
    const bytes = await render(logoLayout(), sampleLabelData(), ZPL_203);
    expect(loadLogo).toHaveBeenCalledWith(LOGO);
    expect(decode(bytes)).toContain("^GFA");
  });

  it("asks for the fallback when the shift froze none, and none for a layout without a logo box", async () => {
    const shift = await workShift(null);
    const loadLogo = vi.fn(async () => null);
    const render = shiftLabelRender(shift, { rasterize: blankText, loadLogo });
    await render(logoLayout(), sampleLabelData(), { language: "tspl", dpi: 203 });
    expect(loadLogo).toHaveBeenCalledWith(null);
    loadLogo.mockClear();
    await render(plainLayout(), sampleLabelData(), ZPL_203);
    expect(loadLogo).not.toHaveBeenCalled();
  });

  it("asks for the fallback when the frozen organization has no logo", async () => {
    const shift = await workShift({ name: "ООО «Пример»", inn: "7701234567", logo: null });
    const loadLogo = vi.fn(async () => null);
    await shiftLabelRender(shift, { rasterize: blankText, loadLogo })(
      logoLayout(),
      sampleLabelData(),
      ZPL_203,
    );
    expect(loadLogo).toHaveBeenCalledWith(null);
  });

  it("prints the organization logo the shift froze as it is, and never loads the Markiro one", async () => {
    const shift = await workShift({ name: "ООО «Пример»", inn: null, logo: MARKIRO });
    const fallbackLogo = vi.fn(async () => LOGO);
    const report = vi.fn();
    const render = shiftLabelRender(shift, { rasterize: blankText, fallbackLogo, report });
    const bytes = decode(await render(logoLayout(), sampleLabelData(), ZPL_203));
    const own = decode(
      await renderLabel(logoLayout(), sampleLabelData(), ZPL_203, blankText, MARKIRO),
    );
    const other = decode(
      await renderLabel(logoLayout(), sampleLabelData(), ZPL_203, blankText, LOGO),
    );
    expect(bytes).toBe(own);
    expect(bytes).not.toBe(other);
    expect(fallbackLogo).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("prints the Markiro logo when the shift froze none, the same bytes as a frozen copy of it", async () => {
    const frozen = await workShift({ name: "ООО «Пример»", inn: null, logo: MARKIRO });
    const none = await workShift(null);
    const report = vi.fn();
    const bytesOf = async (shift: typeof none, fallbackLogo?: () => Promise<MonoBitmap>) =>
      decode(
        await shiftLabelRender(shift, {
          rasterize: blankText,
          report,
          ...(fallbackLogo === undefined ? {} : { fallbackLogo }),
        })(logoLayout(), sampleLabelData(), ZPL_203),
      );
    expect(await bytesOf(none, async () => MARKIRO)).toBe(await bytesOf(frozen));
    expect(report).not.toHaveBeenCalled();
  });

  it("prints with the box empty and says so once when the fallback logo cannot be had", async () => {
    const none = await workShift(null);
    const report = vi.fn<(line: string) => void>();
    const failing = vi.fn(async () => {
      throw new Error("canvas unavailable");
    });
    const render = shiftLabelRender(none, { rasterize: blankText, fallbackLogo: failing, report });
    const bytes = await render(logoLayout(), sampleLabelData(), ZPL_203);
    const bare = await shiftLabelRender(none, {
      rasterize: blankText,
      loadLogo: async () => null,
    })(logoLayout(), sampleLabelData(), ZPL_203);
    expect(decode(bytes)).toBe(decode(bare));
    expect(decode(bytes)).not.toContain("^GFA,32,32,4");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(LOGO_UNAVAILABLE_LINE);
    // The line names neither the shift nor a reason from the webview.
    expect(LOGO_UNAVAILABLE_LINE).toBe("station: label logo unavailable, printing without it");
  });

  it("prints with the box empty and says so when a logo loader itself fails", async () => {
    const none = await workShift(null);
    const report = vi.fn<(line: string) => void>();
    const render = shiftLabelRender(none, {
      rasterize: blankText,
      loadLogo: async () => {
        throw new Error("boom");
      },
      report,
    });
    const bytes = decode(await render(logoLayout(), sampleLabelData(), ZPL_203));
    expect(bytes.startsWith("^XA")).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(LOGO_UNAVAILABLE_LINE);
  });

  it("does not report when the layout has no logo box, whatever the logo", async () => {
    const none = await workShift(null);
    const report = vi.fn();
    const fallbackLogo = vi.fn(async () => {
      throw new Error("no canvas");
    });
    await shiftLabelRender(none, { rasterize: blankText, fallbackLogo, report })(
      plainLayout(),
      sampleLabelData(),
      ZPL_203,
    );
    expect(fallbackLogo).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("writes the line to the console unless a reporter is given", async () => {
    const none = await workShift(null);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await shiftLabelRender(none, {
        rasterize: blankText,
        fallbackLogo: async () => {
          throw new Error("no canvas");
        },
      })(logoLayout(), sampleLabelData(), ZPL_203);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error).toHaveBeenCalledWith(LOGO_UNAVAILABLE_LINE);
    } finally {
      error.mockRestore();
    }
  });

  it("renders one label after another with the logo each time (the Markiro one is loaded per label)", async () => {
    const none = await workShift(null);
    const fallbackLogo = vi.fn(async () => MARKIRO);
    const render = shiftLabelRender(none, { rasterize: blankText, fallbackLogo, report: vi.fn() });
    const first = decode(await render(logoLayout(), sampleLabelData(), ZPL_203));
    const second = decode(await render(logoLayout(), sampleLabelData(), ZPL_203));
    expect(first).toBe(second);
    expect(first).toContain("^GFA");
    expect(fallbackLogo).toHaveBeenCalledTimes(2);
  });
});
