import { DatabaseSync } from "node:sqlite";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeExec } from "./support/sqlite-exec.js";
import {
  StationUpdaterCommandError,
  useStationUpdater,
  type StationUpdateError,
  type StationUpdateHandle,
  type StationUpdaterCommandErrorCode,
  type StationUpdaterPort,
} from "../src/lib/use-station-updater.js";
import type { SqlExecutor } from "../src/lib/mirror.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
  return { db, exec, port, handle };
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
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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
    const installHandle = makeBeta2();
    const { exec, port } = fixture(handle);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ activeShift }) =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift,
          pendingOutbox: 7,
          port,
          now,
        }),
      { initialProps: { activeShift: true } },
    );
    await waitFor(() => expect(port.check).toHaveBeenCalledOnce());
    let denial: unknown;
    await act(async () => {
      try {
        await view.result.current.install();
      } catch (caught) {
        denial = caught;
      }
    });
    expect(denial).toEqual(new Error("active shift"));
    expect(port.check).toHaveBeenCalledOnce();
    expect(handle.downloadAndInstall).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
    expect(view.result.current.origin).toBeNull();
    view.rerender({ activeShift: false });
    vi.mocked(port.check).mockResolvedValueOnce(installHandle);
    await act(async () => view.result.current.install());
    expect(installHandle.downloadAndInstall).toHaveBeenCalledOnce();
    expect(port.relaunch).toHaveBeenCalledOnce();
  });

  it("fails closed for direct check/install calls while an App shift lease is held", async () => {
    const candidate = makeBeta2();
    const { exec, port } = fixture(candidate);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    let leaseHeld = false;
    let synchronouslyActive = false;
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
        updateOperationBlocked: () => leaseHeld,
        activeShiftGuard: () => synchronouslyActive,
      }),
    );
    await waitFor(() => expect(result.current.persisted?.available).not.toBeNull());

    leaseHeld = true;
    await act(async () => result.current.checkNow());
    let blockedInstall: unknown;
    await act(async () => {
      try {
        await result.current.install();
      } catch (caught) {
        blockedInstall = caught;
      }
    });

    expect(blockedInstall).toEqual(new Error("station update operation blocked"));
    expect(port.check).toHaveBeenCalledOnce();
    expect(candidate.downloadAndInstall).not.toHaveBeenCalled();

    leaseHeld = false;
    synchronouslyActive = true;
    let activeInstall: unknown;
    await act(async () => {
      try {
        await result.current.install();
      } catch (caught) {
        activeInstall = caught;
      }
    });

    expect(activeInstall).toEqual(new Error("active shift"));
    expect(port.check).toHaveBeenCalledOnce();
    expect(candidate.downloadAndInstall).not.toHaveBeenCalled();
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
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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
      onProgress({ event: "Started", contentLength: 10 });
      onProgress({ event: "Progress", chunkLength: 6 });
      onProgress({ event: "Finished" });
    });
    const { exec, port } = fixture(handle);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
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
    expect(result.current.downloadedBytes).toBe(10);
  });

  it("maps origin mismatch and integrity failure to distinct terminal errors", async () => {
    const mismatch = fixture();
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const mismatchView = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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
        updateCenterVisible: true,
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

  it("sets busy before install recheck and closes a candidate that arrives after the update center hides", async () => {
    const initial = makeBeta2();
    const stale = makeBeta2();
    const recheck = deferred<StationUpdateHandle | null>();
    const { exec, port } = fixture(initial);
    vi.mocked(port.check).mockResolvedValueOnce(initial).mockReturnValueOnce(recheck.promise);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ visible }) =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: visible,
          exec,
          activeShift: false,
          pendingOutbox: 0,
          port,
          now,
        }),
      { initialProps: { visible: true } },
    );
    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = view.result.current.install().catch(() => undefined);
    });
    await waitFor(() => expect(port.check).toHaveBeenCalledTimes(2));
    expect(view.result.current.phase).toBe("checking");

    view.rerender({ visible: false });
    recheck.resolve(stale);
    await act(async () => installPromise);

    expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.downloadAndInstall).not.toHaveBeenCalled();
    expect(port.relaunch).not.toHaveBeenCalled();
    expect(view.result.current.origin).toBeNull();
    expect(view.result.current.fallbackReason).toBeNull();
    expect(view.result.current.packageFallbackReason).toBeNull();
  });

  it("invalidates install recheck when a shift becomes active", async () => {
    const initial = makeBeta2();
    const stale = makeBeta2();
    const recheck = deferred<StationUpdateHandle | null>();
    const { exec, port } = fixture(initial);
    vi.mocked(port.check).mockResolvedValueOnce(initial).mockReturnValueOnce(recheck.promise);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ activeShift }) =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift,
          pendingOutbox: 0,
          port,
          now,
        }),
      { initialProps: { activeShift: false } },
    );
    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = view.result.current.install().catch(() => undefined);
    });
    await waitFor(() => expect(port.check).toHaveBeenCalledTimes(2));
    view.rerender({ activeShift: true });
    recheck.resolve(stale);
    await act(async () => installPromise);

    expect(stale.close).toHaveBeenCalledOnce();
    expect(stale.downloadAndInstall).not.toHaveBeenCalled();
    expect(port.relaunch).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "waits for an active download after close %s and never relaunches stale work",
    async (closeOutcome) => {
      const initial = makeBeta2();
      const download = deferred<void>();
      const close = deferred<void>();
      const installing = {
        ...makeBeta2(),
        downloadAndInstall: vi.fn(async (onProgress) => {
          onProgress({ event: "Started", contentLength: 10 });
          onProgress({ event: "Progress", chunkLength: 4 });
          onProgress({ event: "Fallback", from: "yandex", to: "github", reason: "timeout" });
          await download.promise;
        }),
        close: vi.fn(() => close.promise),
      };
      const { exec, port } = fixture(initial);
      vi.mocked(port.check).mockResolvedValueOnce(initial).mockResolvedValueOnce(installing);
      const now = () => Date.parse("2026-08-11T00:00:00.000Z");
      const view = renderHook(() =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift: false,
          pendingOutbox: 0,
          port,
          now,
        }),
      );
      await waitFor(() => expect(view.result.current.origin).toBe("yandex"));

      let installPromise!: Promise<void>;
      act(() => {
        installPromise = view.result.current.install().catch(() => undefined);
      });
      await waitFor(() => expect(installing.downloadAndInstall).toHaveBeenCalledOnce());

      let cancellationSettled = false;
      let cancellation!: Promise<void>;
      act(() => {
        cancellation = view.result.current.cancel().then(() => {
          cancellationSettled = true;
        });
      });
      await waitFor(() => expect(installing.close).toHaveBeenCalledOnce());
      if (closeOutcome === "resolve") close.resolve();
      else close.reject(new Error("close failed"));
      await act(async () => Promise.resolve());
      expect(cancellationSettled).toBe(false);

      download.resolve();
      await act(async () => Promise.all([installPromise, cancellation]));

      expect(installing.close).toHaveBeenCalledOnce();
      expect(port.relaunch).not.toHaveBeenCalled();
      expect(view.result.current.origin).toBeNull();
      expect(view.result.current.fallbackReason).toBeNull();
      expect(view.result.current.packageFallbackReason).toBeNull();
      expect(view.result.current.phase).toBe("idle");
    },
  );

  it("signals close and waits when a shift activates during an active download", async () => {
    const initial = makeBeta2();
    const download = deferred<void>();
    const installing = {
      ...makeBeta2(),
      downloadAndInstall: vi.fn(async (onProgress) => {
        onProgress({ event: "Started", contentLength: 10 });
        onProgress({ event: "Progress", chunkLength: 4 });
        await download.promise;
      }),
    };
    const { exec, port } = fixture(initial);
    vi.mocked(port.check).mockResolvedValueOnce(initial).mockResolvedValueOnce(installing);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ activeShift }) =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift,
          pendingOutbox: 0,
          port,
          now,
        }),
      { initialProps: { activeShift: false } },
    );
    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));

    let installPromise!: Promise<void>;
    act(() => {
      installPromise = view.result.current.install().catch(() => undefined);
    });
    await waitFor(() => expect(installing.downloadAndInstall).toHaveBeenCalledOnce());

    view.rerender({ activeShift: true });
    await waitFor(() => expect(installing.close).toHaveBeenCalledOnce());
    expect(view.result.current.origin).toBeNull();
    expect(port.relaunch).not.toHaveBeenCalled();

    download.reject(new StationUpdaterCommandError("installation-failed", false));
    await act(async () => installPromise);

    expect(installing.close).toHaveBeenCalledOnce();
    expect(port.relaunch).not.toHaveBeenCalled();
    expect(view.result.current.phase).toBe("idle");
  });

  it("persists a discovered target before publishing its handle and provenance", async () => {
    const candidate = makeBeta2();
    const { db, exec: realExec, port } = fixture(candidate);
    db.prepare("INSERT INTO station_meta (key, value) VALUES (?, ?)").run(
      "station_update_state_v1",
      JSON.stringify({
        schemaVersion: 1,
        lastAttemptAt: "2026-08-09T00:00:00.000Z",
        lastSuccessfulCheckAt: "2026-08-09T00:00:00.000Z",
        available: {
          version: "0.1.0-beta.1",
          publishedAt: "2026-08-08T00:00:00.000Z",
        },
      }),
    );
    let writes = 0;
    const exec: SqlExecutor = {
      all: (sql, params) => realExec.all(sql, params),
      async run(sql, params) {
        writes += 1;
        if (writes === 2) throw new Error("sqlite rejected known update");
        await realExec.run(sql, params);
      },
    };
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );

    await waitFor(() => expect(result.current.error).toBe("state-write-failed"));
    expect(result.current.persisted?.available?.version).toBe("0.1.0-beta.1");
    expect(result.current.origin).toBeNull();
    expect(result.current.fallbackReason).toBeNull();
    expect(candidate.close).toHaveBeenCalledOnce();
  });

  it("clears and closes candidate state exactly once when disabled", async () => {
    const candidate = makeBeta2();
    const { exec, port } = fixture(candidate);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(
      ({ enabled }) =>
        useStationUpdater({
          enabled,
          updateCenterVisible: true,
          exec,
          activeShift: false,
          pendingOutbox: 0,
          port,
          now,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));

    view.rerender({ enabled: false });
    await waitFor(() => expect(candidate.close).toHaveBeenCalledOnce());
    expect(view.result.current.origin).toBeNull();
    expect(view.result.current.fallbackReason).toBeNull();
    expect(view.result.current.packageFallbackReason).toBeNull();
  });

  it("clears a previously known update when closing its candidate fails terminally", async () => {
    const candidate = makeBeta2();
    vi.mocked(candidate.close).mockRejectedValueOnce(
      new StationUpdaterCommandError("candidate-invalid", false),
    );
    const { exec, port } = fixture(candidate);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(result.current.persisted?.available).not.toBeNull());

    await act(async () => result.current.checkNow());

    expect(result.current.error).toBe("candidate-invalid");
    expect(result.current.persisted?.available).toBeNull();
    expect(result.current.origin).toBeNull();
    expect(port.check).toHaveBeenCalledOnce();
    expect(candidate.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["integrity-failed", "integrity-failed"],
    ["installation-failed", "install-failed"],
  ] as const)(
    "clears candidate state after the terminal %s download failure",
    async (code, expected) => {
      const initial = makeBeta2();
      const installing = {
        ...makeBeta2(),
        origin: "github" as const,
        fallbackReason: "primary-unavailable" as const,
        downloadAndInstall: vi.fn(async (onProgress) => {
          onProgress({ event: "Fallback", from: "yandex", to: "github", reason: "network" });
          throw new StationUpdaterCommandError(code, false);
        }),
      };
      const { exec, port } = fixture(initial);
      vi.mocked(port.check).mockResolvedValueOnce(initial).mockResolvedValueOnce(installing);
      const now = () => Date.parse("2026-08-11T00:00:00.000Z");
      const { result } = renderHook(() =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift: false,
          pendingOutbox: 0,
          port,
          now,
        }),
      );
      await waitFor(() => expect(result.current.origin).toBe("yandex"));

      await act(async () => {
        await result.current.install().catch(() => undefined);
      });

      expect(result.current.error).toBe(expected);
      expect(result.current.origin).toBeNull();
      expect(result.current.fallbackReason).toBeNull();
      expect(result.current.packageFallbackReason).toBeNull();
      expect(installing.close).toHaveBeenCalledOnce();
    },
  );

  it("clears candidate state and reports an internal error when relaunch fails", async () => {
    const initial = makeBeta2();
    const installing = { ...makeBeta2(), downloadAndInstall: vi.fn() };
    installing.downloadAndInstall.mockImplementation(async (onProgress) => {
      onProgress({ event: "Fallback", from: "yandex", to: "github", reason: "timeout" });
      onProgress({ event: "Started", contentLength: 10 });
      onProgress({ event: "Progress", chunkLength: 10 });
      onProgress({ event: "Finished" });
    });
    const { exec, port } = fixture(initial);
    vi.mocked(port.check).mockResolvedValueOnce(initial).mockResolvedValueOnce(installing);
    vi.mocked(port.relaunch).mockRejectedValueOnce(new Error("relaunch failed"));
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(result.current.origin).toBe("yandex"));

    await act(async () => {
      await result.current.install().catch(() => undefined);
    });

    expect(result.current.error).toBe("internal-error");
    expect(result.current.origin).toBeNull();
    expect(result.current.fallbackReason).toBeNull();
    expect(result.current.packageFallbackReason).toBeNull();
    expect(installing.close).toHaveBeenCalledOnce();
  });

  const errorCases: ReadonlyArray<readonly [StationUpdaterCommandErrorCode, StationUpdateError]> = [
    ["origins-unavailable", "check-failed"],
    ["origin-mismatch", "origin-mismatch"],
    ["integrity-failed", "integrity-failed"],
    ["policy-denied", "policy-denied"],
    ["check-superseded", "check-superseded"],
    ["candidate-invalid", "candidate-invalid"],
    ["candidate-expired", "candidate-invalid"],
    ["installation-failed", "install-failed"],
    ["internal", "internal-error"],
  ];

  it.each(errorCases)(
    "maps check error %s deliberately and retains a known update only for availability",
    async (code, expected) => {
      const initial = makeBeta2();
      const { exec, port } = fixture(initial);
      const now = () => Date.parse("2026-08-11T00:00:00.000Z");
      const view = renderHook(() =>
        useStationUpdater({
          enabled: true,
          updateCenterVisible: true,
          exec,
          activeShift: false,
          pendingOutbox: 0,
          port,
          now,
        }),
      );
      await waitFor(() => expect(view.result.current.origin).toBe("yandex"));
      vi.mocked(port.check).mockRejectedValueOnce(
        new StationUpdaterCommandError(code, code === "origins-unavailable"),
      );

      await act(async () => view.result.current.checkNow());

      expect(view.result.current.error).toBe(expected);
      if (code === "origins-unavailable") {
        expect(view.result.current.persisted?.available?.version).toBe("0.1.0-beta.2");
      } else {
        expect(view.result.current.persisted?.available).toBeNull();
      }
      view.unmount();
    },
  );

  it.each(errorCases)("maps install error %s deliberately", async (code, expected) => {
    const initial = makeBeta2();
    const { exec, port } = fixture(initial);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const view = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(view.result.current.origin).toBe("yandex"));
    vi.mocked(port.check).mockRejectedValueOnce(
      new StationUpdaterCommandError(code, code === "origins-unavailable"),
    );

    await act(async () => {
      await view.result.current.install().catch(() => undefined);
    });

    expect(view.result.current.error).toBe(expected);
    view.unmount();
  });

  it("maps malformed Rust error payloads to terminal invalid metadata", async () => {
    const initial = makeBeta2();
    const { exec, port } = fixture(initial);
    const now = () => Date.parse("2026-08-11T00:00:00.000Z");
    const { result } = renderHook(() =>
      useStationUpdater({
        enabled: true,
        updateCenterVisible: true,
        exec,
        activeShift: false,
        pendingOutbox: 0,
        port,
        now,
      }),
    );
    await waitFor(() => expect(result.current.origin).toBe("yandex"));
    vi.mocked(port.check).mockRejectedValueOnce(new Error("invalid station update error"));

    await act(async () => result.current.checkNow());

    expect(result.current.error).toBe("invalid-metadata");
    expect(result.current.persisted?.available).toBeNull();
  });
});
