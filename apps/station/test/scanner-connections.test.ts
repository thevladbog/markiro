import { describe, expect, it, vi, beforeEach } from "vitest";

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: ipc.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: ipc.listen }));
import { tauriHardware } from "../src/lib/hardware.js";

describe("scanner connection snapshot subscription", () => {
  beforeEach(() => {
    ipc.invoke.mockReset();
    ipc.listen.mockReset();
  });

  it("reports partial availability when one of two COM scanners is disconnected", async () => {
    ipc.listen.mockResolvedValue(() => {});
    ipc.invoke.mockResolvedValue({
      revision: 4,
      scanners: [
        { port: "COM3", baud: 9600, status: "connected" },
        { port: "COM4", baud: 115200, status: "disconnected" },
      ],
    });
    const seen: string[] = [];
    const stop = await tauriHardware.onScannerStatus((status) => seen.push(status));
    expect(seen).toEqual(["partial"]);
    stop();
  });

  it("does not overwrite a newer event with a delayed initial snapshot", async () => {
    let emit: (event: { payload: unknown }) => void = () => {};
    ipc.listen.mockImplementation(async (_name, listener) => {
      emit = listener;
      return () => {};
    });
    let resolve: (snapshot: unknown) => void = () => {};
    ipc.invoke.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const seen: string[] = [];
    const pending = tauriHardware.onScannerStatus((status) => seen.push(status));
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledWith("get_scanner_connections"));
    emit({
      payload: { revision: 8, scanners: [{ port: "COM4", baud: 9600, status: "connected" }] },
    });
    resolve({ revision: 7, scanners: [{ port: "COM4", baud: 9600, status: "disconnected" }] });
    const stop = await pending;
    expect(seen).toEqual(["connected"]);
    stop();
  });

  it("releases the listener if the initial snapshot command fails", async () => {
    const stop = vi.fn();
    ipc.listen.mockResolvedValue(stop);
    ipc.invoke.mockRejectedValue(new Error("IPC unavailable"));
    await expect(tauriHardware.onScannerStatus(() => {})).rejects.toThrow("IPC unavailable");
    expect(stop).toHaveBeenCalledOnce();
  });
});
