import { describe, expect, it, vi } from "vitest";
import type { LabelTemplateSpec } from "@markiro/domain";
import { attemptBoxPrint, type BoxPrintInput } from "../src/lib/box-printing.js";
import type { PrintTarget } from "../src/lib/hardware.js";

const PRINT_TARGET: PrintTarget = { kind: "tcp", host: "10.0.0.5", port: 9100 };
const BOX_TEMPLATE: LabelTemplateSpec = {
  widthMm: 58,
  heightMm: 40,
  dpi: 203,
  language: "zpl",
  elements: [],
};

function configuredInput(): BoxPrintInput {
  return {
    template: BOX_TEMPLATE,
    fields: { sscc: "046012345600007778" },
    printing: {
      target: PRINT_TARGET,
      language: "zpl",
      print: vi.fn(async () => {}),
    },
    render: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
}

describe("attemptBoxPrint", () => {
  it("classifies a missing box template before attempting render or transport", async () => {
    const input = configuredInput();

    await expect(attemptBoxPrint({ ...input, template: null })).resolves.toEqual({
      kind: "failed",
      code: "template_missing",
    });
    expect(input.render).not.toHaveBeenCalled();
    expect(input.printing?.print).not.toHaveBeenCalled();
  });

  it("classifies an unconfigured printer before rendering", async () => {
    const input = configuredInput();

    await expect(attemptBoxPrint({ ...input, printing: null })).resolves.toEqual({
      kind: "failed",
      code: "printer_unconfigured",
    });
    expect(input.render).not.toHaveBeenCalled();
  });

  it("sanitizes render failures to a fixed category", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = configuredInput();

    await expect(
      attemptBoxPrint({
        ...input,
        render: vi.fn(async () => {
          throw new Error("secret native detail");
        }),
      }),
    ).resolves.toEqual({ kind: "failed", code: "render_failed" });
    expect(error).toHaveBeenCalledWith("station: box label render failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("secret native detail");
    expect(input.printing?.print).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("sanitizes printer transport failures to a fixed category", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const input = configuredInput();
    const print = vi.fn(async () => {
      throw new Error("COM3 access denied");
    });

    await expect(
      attemptBoxPrint({ ...input, printing: { ...input.printing!, print } }),
    ).resolves.toEqual({ kind: "failed", code: "transport_failed" });
    expect(error).toHaveBeenCalledWith("station: box label transport failed");
    expect(JSON.stringify(error.mock.calls)).not.toContain("COM3 access denied");
    error.mockRestore();
  });

  it("returns the rendered bytes after one successful transport", async () => {
    const input = configuredInput();

    await expect(attemptBoxPrint(input)).resolves.toEqual({
      kind: "printed",
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(input.printing?.print).toHaveBeenCalledWith(PRINT_TARGET, new Uint8Array([1, 2, 3]));
  });
});
