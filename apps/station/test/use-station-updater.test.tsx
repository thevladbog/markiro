import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeExec } from "./support/sqlite-exec.js";
import {
  useStationUpdater,
  type StationUpdateHandle,
  type StationUpdaterPort,
} from "../src/lib/use-station-updater.js";

const beta2: StationUpdateHandle = {
  currentVersion: "0.1.0-beta.1",
  version: "0.1.0-beta.2",
  publishedAt: "2026-08-10T00:00:00.000Z",
  downloadAndInstall: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
};

function fixture(handle: StationUpdateHandle | null = beta2) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE station_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const exec = makeExec(db);
  const port: StationUpdaterPort = {
    check: vi.fn().mockResolvedValue(handle),
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
  return { exec, port };
}

describe("useStationUpdater", () => {
  it("checks once after enable, throttles remounts, and never downloads automatically", async () => {
    const { exec, port } = fixture();
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result, unmount } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(port.check).toHaveBeenCalledOnce());
    expect(beta2.downloadAndInstall).not.toHaveBeenCalled();
    expect(result.current.persisted?.available?.version).toBe("0.1.0-beta.2");
    unmount();
  });

  it("denies install during a shift and installs only after explicit invocation", async () => {
    const { exec, port } = fixture();
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ activeShift }) =>
        useStationUpdater({
          enabled: true,
          exec,
          activeShift,
          pendingOutbox: 7,
          port,
          now,
        }),
      { initialProps: { activeShift: true } },
    );
    await waitFor(() => expect(port.check).toHaveBeenCalledOnce());
    await expect(view.result.current.install()).rejects.toThrow("active shift");
    expect(beta2.downloadAndInstall).not.toHaveBeenCalled();
    view.rerender({ activeShift: false });
    await act(async () => view.result.current.install());
    expect(beta2.downloadAndInstall).toHaveBeenCalledOnce();
    expect(port.relaunch).toHaveBeenCalledOnce();
  });

  it("bypasses the automatic throttle on a manual check and reports download progress", async () => {
    const handle = { ...beta2, downloadAndInstall: vi.fn() };
    handle.downloadAndInstall.mockImplementation(async (onProgress) => {
      onProgress({ event: "Started", contentLength: 10 });
      onProgress({ event: "Progress", chunkLength: 4 });
      onProgress({ event: "Progress", chunkLength: 6 });
      onProgress({ event: "Finished" });
    });
    const { exec, port } = fixture(handle);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(port.check).toHaveBeenCalledOnce());
    await act(async () => result.current.checkNow());
    expect(port.check).toHaveBeenCalledTimes(2);
    await act(async () => result.current.install());
    expect(result.current.downloadedBytes).toBe(10);
    expect(result.current.totalBytes).toBe(10);
  });
});
