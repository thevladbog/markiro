import { decodeMonoRaster } from "@markiro/domain";
import { openProductLabelWork } from "./support/product-label-work.js";
import { readPrintDestination, replacePrintDestination } from "../src/lib/print-destinations.js";
import { tauriWindowsPrinting } from "../src/lib/hardware.js";
import type { PrinterProfile } from "../src/lib/printer-routing.js";
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
      dpi: 300,
      print: vi.fn(async () => {}),
    },
    render: vi.fn(async () => new Uint8Array([1, 2, 3])),
  };
}

describe("attemptBoxPrint", () => {
  it("keeps recovery retryable and sends nothing when saving the destination fails", async () => {
    const input = configuredInput();
    const failure = new Error("private sqlite details");
    const destination = {
      exec: { run: vi.fn(() => Promise.reject(failure)), all: vi.fn(() => Promise.resolve([])) },
      key: { scope: "owner", purpose: "box" as const, jobId: "label", attemptId: "initial" },
    };
    await expect(attemptBoxPrint({ ...input, destination })).resolves.toEqual({
      kind: "failed",
      code: "persistence_failed",
    });
    expect(input.render).not.toHaveBeenCalled();
    expect(input.printing?.print).not.toHaveBeenCalled();
  });
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

  it("hands the printer's resolution to the renderer", async () => {
    const input = configuredInput();

    await attemptBoxPrint(input);
    expect(input.render).toHaveBeenCalledWith(
      BOX_TEMPLATE,
      { sscc: "046012345600007778" },
      "zpl",
      300,
    );
  });

  it("passes null through for legacy settings without a resolution", async () => {
    const input = configuredInput();
    // A transport saved before the resolution setting existed carries no `dpi`.
    const legacyPrinting = {
      target: PRINT_TARGET,
      language: "zpl" as const,
      print: vi.fn(async () => {}),
    };

    await attemptBoxPrint({ ...input, printing: legacyPrinting });
    expect(input.render).toHaveBeenCalledWith(
      BOX_TEMPLATE,
      { sscc: "046012345600007778" },
      "zpl",
      null,
    );
  });
});

it.each(["box", "pallet"] as const)(
  "prints a %s after correcting a preflight DPI mismatch",
  async (purpose) => {
    const w = await openProductLabelWork();
    const old: PrinterProfile = {
      id: "win",
      name: "Queue",
      target: { kind: "usb", printer: "Queue" },
      language: "zpl",
      mode: "windows_driver",
      dpi: 300,
    };
    const corrected: PrinterProfile = { ...old, dpi: 203 };
    const key = { scope: "shift", purpose, jobId: "sscc", attemptId: "label" };
    const preflight = vi
      .spyOn(tauriWindowsPrinting, "preflightWindowsRaster")
      .mockImplementation(async (_, bytes) =>
        decodeMonoRaster(bytes).dpi === 203
          ? { ok: true }
          : { ok: false, error: { code: "geometry_mismatch", phase: "before_start" } },
      );
    const send = vi
      .spyOn(tauriWindowsPrinting, "printWindowsRaster")
      .mockImplementation(async (queue, bytes, documentName) => {
        expect(decodeMonoRaster(bytes).dpi).toBe(203);
        return { ok: true, receipt: { queue, jobId: 1, documentName } };
      });
    try {
      const input = {
        ...configuredInput(),
        destination: { exec: w.exec, key },
        printing: {
          target: old.target,
          profile: old,
          language: old.language,
          dpi: old.dpi,
          print: vi.fn(),
        },
      };
      expect(await attemptBoxPrint(input)).toEqual({ kind: "failed", code: "transport_failed" });
      expect(send).not.toHaveBeenCalled();
      const saved = await readPrintDestination(w.exec, key);
      expect(saved).toEqual(old);
      if (!saved) throw new Error("Saved destination missing");
      expect(await replacePrintDestination(w.exec, key, saved, corrected)).toBe(true);
      expect(
        await attemptBoxPrint({
          ...input,
          explicitRetry: true,
          printing: { ...input.printing, profile: corrected, dpi: corrected.dpi },
        }),
      ).toMatchObject({ kind: "printed" });
      expect(send).toHaveBeenCalledTimes(1);
      expect(await w.exec.all("SELECT state FROM printer_deliveries ORDER BY rowid")).toEqual([
        { state: "failed_before_send" },
        { state: "sent" },
      ]);
    } finally {
      preflight.mockRestore();
      send.mockRestore();
      w.close();
    }
  },
);

const LOGO_TEMPLATE: LabelTemplateSpec = {
  ...BOX_TEMPLATE,
  elements: [
    {
      id: "logo",
      kind: "organization_logo",
      source: "organization",
      fallback: "markiro",
      xMm: 4,
      yMm: 3,
      widthMm: 30,
      heightMm: 7,
    },
  ],
};
const TEST_LOGO = {
  width: 8,
  height: 4,
  stride: 1,
  pixels: new Uint8Array([0x80, 0x40, 0x20, 0x10]),
};
it("supplies owner branding only to fresh logo labels and does not query it for 58×40", async () => {
  const input = configuredInput();
  const loadLogo = vi.fn(async () => TEST_LOGO);
  expect(await attemptBoxPrint({ ...input, template: LOGO_TEMPLATE, loadLogo })).toMatchObject({
    kind: "printed",
  });
  expect(input.render).toHaveBeenCalledWith(LOGO_TEMPLATE, input.fields, "zpl", 300, TEST_LOGO);
  loadLogo.mockClear();
  await attemptBoxPrint({ ...input, loadLogo });
  expect(loadLogo).not.toHaveBeenCalled();
});
it("sends nothing and keeps logo failures recoverable", async () => {
  const input = configuredInput();
  const loadLogo = vi.fn(async () => {
    throw new Error("branding unavailable");
  });
  expect(await attemptBoxPrint({ ...input, template: LOGO_TEMPLATE, loadLogo })).toEqual({
    kind: "failed",
    code: "render_failed",
  });
  expect(input.render).not.toHaveBeenCalled();
  expect(input.printing?.print).not.toHaveBeenCalled();
});
it("replays an uncertain Windows delivery from frozen logo bytes while offline", async () => {
  const w = await openProductLabelWork();
  const profile: PrinterProfile = {
    id: "win",
    name: "Queue",
    target: { kind: "usb", printer: "Queue" },
    language: "zpl",
    mode: "windows_driver",
    dpi: 203,
  };
  const preflight = vi
    .spyOn(tauriWindowsPrinting, "preflightWindowsRaster")
    .mockResolvedValue({ ok: true });
  let dispatchCount = 0;
  const send = vi
    .spyOn(tauriWindowsPrinting, "printWindowsRaster")
    .mockImplementation(async (queue, bytes, documentName) => {
      expect(decodeMonoRaster(bytes).pixels.some((byte) => byte !== 0)).toBe(true);
      dispatchCount++;
      return dispatchCount === 1
        ? { ok: false, error: { code: "driver_failure", phase: "delivery_unknown" } }
        : { ok: true, receipt: { queue, jobId: 1, documentName } };
    });
  const loadLogo = vi.fn(async () => TEST_LOGO);
  const input = {
    ...configuredInput(),
    template: LOGO_TEMPLATE,
    loadLogo,
    destination: {
      exec: w.exec,
      key: { scope: "shift", purpose: "box" as const, jobId: "sscc", attemptId: "label" },
    },
    printing: {
      target: profile.target,
      profile,
      language: profile.language,
      dpi: profile.dpi,
      print: vi.fn(),
    },
  };
  try {
    const first = await attemptBoxPrint(input);
    expect(first).toEqual({ kind: "failed", code: "transport_failed" });
    loadLogo.mockClear();
    loadLogo.mockRejectedValue(new Error("offline"));
    const second = await attemptBoxPrint({ ...input, explicitRetry: true });
    expect(second.kind).toBe("printed");
    expect(send.mock.calls[1]?.[1]).toEqual(send.mock.calls[0]?.[1]);
    expect(loadLogo).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    preflight.mockRestore();
    send.mockRestore();
    w.close();
  }
});
