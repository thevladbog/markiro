// @vitest-environment node
import { expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { probeWindowsA4Printing, tauriWindowsPrinting } from "../src/lib/hardware.js";
it("old shells and non-Windows never advertise A4", async () => {
  invoke.mockRejectedValueOnce(new Error("unknown command"));
  expect(await probeWindowsA4Printing()).toBe(false);
  invoke.mockResolvedValueOnce(false);
  expect(await probeWindowsA4Printing()).toBe(false);
  invoke.mockResolvedValueOnce(true);
  expect(await probeWindowsA4Printing()).toBe(true);
});
it("passes frozen A4 options and geometry through both sending boundaries", async () => {
  const pageOptions = { mode: "a4_sheet", orientation: "landscape" } as const;
  const sheet = { pageOptions, geometryFingerprint: "a4-v1:test" };
  invoke.mockResolvedValue({ ok: true });
  await tauriWindowsPrinting.preflightWindowsRaster("Queue", new Uint8Array([1]), sheet);
  expect(invoke).toHaveBeenLastCalledWith("preflight_windows_raster", {
    queue: "Queue",
    payloadBase64: "AQ==",
    ...sheet,
  });
  await tauriWindowsPrinting.printWindowsRaster("Queue", new Uint8Array([1]), "Markiro:job", sheet);
  expect(invoke).toHaveBeenLastCalledWith("print_windows_raster", {
    queue: "Queue",
    payloadBase64: "AQ==",
    documentName: "Markiro:job",
    ...sheet,
  });
});
