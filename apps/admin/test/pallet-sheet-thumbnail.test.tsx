import { buildPalletSheetPresets } from "@markiro/domain";
import { render, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TemplateThumb } from "../src/pages/labels/TemplateThumb.js";
import { loadCabinetSheetBranding } from "../src/pages/labels/editor/sheet/sheet-branding.js";
import { renderSheetPreview } from "../src/pages/labels/editor/sheet/sheet-preview.js";
const presets = buildPalletSheetPresets();
vi.mock("../src/pages/labels/api.js", () => ({
  useLabelTemplate: (id: string) => ({
    data: { spec: presets[Number(id)]!.spec, purpose: "pallet" },
  }),
}));
vi.mock("../src/pages/labels/editor/sheet/sheet-branding.js", () => ({
  loadCabinetSheetBranding: vi.fn(async () => ({
    organizationName: "Plant",
    logo: { width: 1, height: 1, stride: 1, pixels: Uint8Array.of(128) },
  })),
}));
vi.mock("../src/pages/labels/editor/sheet/sheet-preview.js", () => ({
  renderSheetPreview: vi.fn(async () => ({})),
  paintSheetRaster: vi.fn(),
  previewSheetContext: vi.fn(() => ({})),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("keeps every A4 library thumbnail bounded and avoids print rendering or private branding requests", async () => {
  const context = {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    setLineDash: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  const { container } = render(
    <>
      {presets.map((preset, index) => (
        <TemplateThumb
          key={index}
          id={String(index)}
          widthMm={preset.spec.page.orientation === "portrait" ? 210 : 297}
          heightMm={preset.spec.page.orientation === "portrait" ? 297 : 210}
        />
      ))}
    </>,
  );
  await Promise.resolve();
  expect(loadCabinetSheetBranding).not.toHaveBeenCalled();
  expect(renderSheetPreview).not.toHaveBeenCalled();
  const canvases = [...container.querySelectorAll("canvas")];
  expect(canvases).toHaveLength(3);
  for (const canvas of canvases) {
    expect(canvas.width).toBeLessThanOrEqual(150);
    expect(canvas.height).toBeLessThanOrEqual(110);
  }
  expect(context.fillRect).toHaveBeenCalled();
});
