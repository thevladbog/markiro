import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, listen } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { createTauriHardware, SCAN_EVENT, SCANNER_STATUS_EVENT } from "../src/hardware/hardware.js";

describe("the hardware wrapper over Tauri's own invoke and listen", () => {
  beforeEach(() => {
    invoke.mockReset();
    listen.mockReset();
  });

  it("calls the shell through Tauri's invoke by default", async () => {
    invoke.mockResolvedValue(null);
    const hardware = createTauriHardware();
    await expect(
      hardware.printBytes({ kind: "tcp", host: "10.0.0.7", port: 9100 }, new Uint8Array([65])),
    ).resolves.toEqual({ sent: true });
    expect(invoke).toHaveBeenCalledWith("print_bytes", {
      target: { kind: "tcp", host: "10.0.0.7", port: 9100 },
      payloadBase64: "QQ==",
    });
    await hardware.setSystemAwake(true);
    expect(invoke).toHaveBeenLastCalledWith("set_system_awake", { awake: true });
  });

  it("hears the shell's events through Tauri's listen by default", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    const scans: string[] = [];
    const stop = await createTauriHardware().onScan((raw) => scans.push(raw));
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]?.[0]).toBe(SCAN_EVENT);

    const handler: unknown = listen.mock.calls[0]?.[1];
    if (typeof handler !== "function") throw new Error("no handler was registered");
    handler({ event: SCAN_EVENT, id: 1, payload: "0104600000000015\u001d91key" });
    expect(scans).toEqual(["0104600000000015\u001d91key"]);

    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("subscribes to the status event, then asks, through Tauri by default", async () => {
    const unlisten = vi.fn();
    listen.mockResolvedValue(unlisten);
    invoke.mockResolvedValue({ revision: 0, scanners: [] });
    const seen: unknown[] = [];
    await createTauriHardware().watchScanners((snapshot) => seen.push(snapshot));
    expect(listen.mock.calls[0]?.[0]).toBe(SCANNER_STATUS_EVENT);
    expect(invoke).toHaveBeenCalledWith("get_scanner_connections", {});
    expect(seen).toEqual([{ revision: 0, scanners: [] }]);
  });
});
