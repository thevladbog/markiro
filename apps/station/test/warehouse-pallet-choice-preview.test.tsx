import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { sheetChoice } from "../../../packages/domain/test/support/pallet-reprint.js";
import { createCredentialGeneration } from "../src/lib/credential-recovery.js";
import { PalletChoicePreview } from "../src/ui/warehouse-reprint/PalletChoicePreview.js";
import { renderPalletSheet } from "@markiro/domain";
import type * as Domain from "@markiro/domain";
vi.mock("@markiro/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof Domain>()),
  renderPalletSheet: vi.fn(async () => ({
    format: "mono-raster-v1",
    widthMm: 210,
    heightMm: 297,
    dpi: 300,
    widthDots: 2480,
    heightDots: 3508,
    stride: 310,
    requiredBounds: { left: 0, top: 0, right: 2480, bottom: 3508 },
    pixels: new Uint8Array(310 * 3508),
  })),
}));
vi.mock("../src/lib/organization-branding.js", () => ({
  loadOrganizationBranding: async () => null,
  loadBundledMarkiroLogo: async () => ({
    width: 8,
    height: 1,
    stride: 1,
    pixels: Uint8Array.of(128),
  }),
}));
vi.mock("../src/lib/device-recovery.js", () => ({ readDeviceRecovery: async () => null }));
it("bounds A4 screen pixels and reuses the same owner-scoped layout when reopened", async () => {
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: vi.fn(),
    imageSmoothingEnabled: false,
  };
  const spy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue(context as unknown as CanvasRenderingContext2D);
  const choice = sheetChoice();
  const owner = {
    exec: { run: async () => {}, all: async () => [] },
    generation: createCredentialGeneration("preview-owner"),
  };
  try {
    const cold = performance.now();
    let view = render(<PalletChoicePreview choice={choice} logoOwner={owner} />);
    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
    const canvas = screen.getByRole("img") as HTMLCanvasElement;
    expect(Math.max(canvas.width, canvas.height)).toBe(800);
    expect(canvas.width / canvas.height).toBeCloseTo(2480 / 3508, 2);
    const coldMs = performance.now() - cold;
    view.unmount();
    const warm = performance.now();
    view = render(<PalletChoicePreview choice={{ ...choice }} logoOwner={owner} />);
    await waitFor(() => expect(screen.getByRole("img")).toBeTruthy());
    expect(renderPalletSheet).toHaveBeenCalledTimes(1);
    console.info(
      JSON.stringify({
        preview: "A4 layout mocked; canvas real pixel loop",
        coldMs: Math.round(coldMs),
        warmMs: Math.round(performance.now() - warm),
      }),
    );
    view.unmount();
  } finally {
    spy.mockRestore();
  }
});
