import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExec } from "./support/sqlite-exec.js";
import {
  StationUpdaterCommandError,
  useStationUpdater,
  type StationUpdateHandle,
  type StationUpdaterPort,
} from "../src/lib/use-station-updater.js";

function makeBeta2(): StationUpdateHandle {
  return {
    currentVersion: "0.1.0-beta.1",
    version: "0.1.0-beta.2",
    publishedAt: "2026-08-10T00:00:00.000Z",
    origin: "yandex",
    fallbackReason: null,
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function fixture(handle: StationUpdateHandle | null = makeBeta2()) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE station_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const exec = makeExec(db);
  const port: StationUpdaterPort = {
    check: vi.fn().mockResolvedValue(handle),
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
  return { exec, port, handle };
}

describe("useStationUpdater", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  it("checks once after enable, throttles remounts, and never downloads automatically", async () => {
    const { exec, port, handle } = fixture();
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
    expect(handle?.downloadAndInstall).not.toHaveBeenCalled();
    expect(result.current.persisted?.available?.version).toBe("0.1.0-beta.2");
    unmount();
  });

  it("rechecks a persisted available version on startup and clears it after an upgrade", async () => {
    const { exec, port } = fixture();
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const first = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() =>
      expect(first.result.current.persisted?.available?.version).toBe("0.1.0-beta.2"),
    );
    first.unmount();

    vi.mocked(port.check).mockClear().mockResolvedValue(null);
    const upgraded = renderHook(() =>
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
    await waitFor(() => expect(upgraded.result.current.persisted?.available).toBeNull());
  });

  it("denies install during a shift and installs only after explicit invocation", async () => {
    const handle = makeBeta2();
    const { exec, port } = fixture(handle);
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
    expect(port.check).toHaveBeenCalledOnce();
    expect(handle.downloadAndInstall).not.toHaveBeenCalled();
    view.rerender({ activeShift: false });
    await act(async () => view.result.current.install());
    expect(handle.downloadAndInstall).toHaveBeenCalledOnce();
    expect(port.relaunch).toHaveBeenCalledOnce();
  });

  it("bypasses the automatic throttle on a manual check and reports download progress", async () => {
    const handle = { ...makeBeta2(), downloadAndInstall: vi.fn() };
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

  it("closes replaced and unmounted candidates while source state follows only the current one", async () => {
    const primary = makeBeta2();
    const fallback = {
      ...makeBeta2(),
      origin: "github" as const,
      fallbackReason: "primary-metadata-invalid" as const,
    };
    const { exec, port } = fixture(primary);
    vi.mocked(port.check).mockResolvedValueOnce(primary).mockResolvedValueOnce(fallback);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );

    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));
    await act(async () => view.result.current.checkNow());
    expect(primary.close).toHaveBeenCalledOnce();
    expect(view.result.current.origin).toBe("github");
    expect(view.result.current.fallbackReason).toBe("primary-metadata-invalid");

    view.unmount();
    await waitFor(() => expect(fallback.close).toHaveBeenCalledOnce());
  });

  it("retains a known update but clears stale origin state when both origins are unavailable", async () => {
    const primary = makeBeta2();
    const { exec, port } = fixture(primary);
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
    await waitFor(() => expect(result.current.origin).toBe("yandex"));

    vi.mocked(port.check).mockRejectedValueOnce(
      new StationUpdaterCommandError("origins-unavailable", true),
    );
    await act(async () => result.current.checkNow());

    expect(result.current.persisted?.available?.version).toBe("0.1.0-beta.2");
    expect(result.current.origin).toBeNull();
    expect(result.current.fallbackReason).toBeNull();
    expect(result.current.error).toBe("check-failed");
  });

  it("surfaces package fallback separately from discovery provenance", async () => {
    const handle = { ...makeBeta2(), downloadAndInstall: vi.fn() };
    handle.downloadAndInstall.mockImplementation(async (onProgress) => {
      onProgress({ event: "Started", contentLength: 10 });
      onProgress({ event: "Progress", chunkLength: 4 });
      onProgress({ event: "Fallback", from: "yandex", to: "github", reason: "network" });
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
    await act(async () => result.current.install());

    expect(result.current.origin).toBe("yandex");
    expect(result.current.fallbackReason).toBeNull();
    expect(result.current.packageFallbackReason).toBe("network");
  });

  it("maps origin mismatch and integrity failure to distinct terminal errors", async () => {
    const mismatch = fixture();
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const mismatchView = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec: mismatch.exec,
        activeShift: false,
        pendingOutbox: 0,
        port: mismatch.port,
        now,
      }),
    );
    await waitFor(() => expect(mismatch.port.check).toHaveBeenCalledOnce());
    vi.mocked(mismatch.port.check).mockRejectedValueOnce(
      new StationUpdaterCommandError("origin-mismatch", false),
    );
    let mismatchError: unknown;
    await act(async () => {
      try {
        await mismatchView.result.current.install();
      } catch (caught) {
        mismatchError = caught;
      }
    });
    expect(mismatchError).toBeInstanceOf(StationUpdaterCommandError);
    expect(mismatchView.result.current.error).toBe("origin-mismatch");
    mismatchView.unmount();

    const integrityHandle = makeBeta2();
    vi.mocked(integrityHandle.downloadAndInstall).mockRejectedValueOnce(
      new StationUpdaterCommandError("integrity-failed", false),
    );
    const integrity = fixture(integrityHandle);
    const integrityView = renderHook(() =>
      useStationUpdater({
        enabled: true,
        exec: integrity.exec,
        activeShift: false,
        pendingOutbox: 0,
        port: integrity.port,
        now,
      }),
    );
    await waitFor(() => expect(integrity.port.check).toHaveBeenCalledOnce());
    let integrityError: unknown;
    await act(async () => {
      try {
        await integrityView.result.current.install();
      } catch (caught) {
        integrityError = caught;
      }
    });
    expect(integrityError).toBeInstanceOf(StationUpdaterCommandError);
    expect(integrityView.result.current.error).toBe("integrity-failed");
  });

  it("rejects a same-version target whose canonical publication date changed", async () => {
    const initial = makeBeta2();
    const changed = { ...makeBeta2(), publishedAt: "2026-08-10T00:00:01.000Z" };
    const { exec, port } = fixture(initial);
    vi.mocked(port.check).mockResolvedValueOnce(initial).mockResolvedValueOnce(changed);
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

    let installError: unknown;
    await act(async () => {
      try {
        await result.current.install();
      } catch (caught) {
        installError = caught;
      }
    });
    expect(installError).toEqual(new Error("target changed"));
    expect(changed.downloadAndInstall).not.toHaveBeenCalled();
    expect(result.current.error).toBe("target-changed");
  });
});
