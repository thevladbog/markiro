import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

import { tauriStationUpdater } from "../src/lib/tauri-updater.js";

describe("tauri station updater adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps Tauri date and closes resources without enabling downgrades", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    checkMock.mockResolvedValue({
      currentVersion: "0.1.0-beta.1",
      version: "0.1.0-beta.2",
      date: "2026-08-11T00:00:00.000Z",
      downloadAndInstall: vi.fn(),
      close,
    });
    const update = await tauriStationUpdater.check();
    expect(checkMock).toHaveBeenCalledWith({ timeout: 15_000, allowDowngrades: false });
    expect(update).toMatchObject({
      currentVersion: "0.1.0-beta.1",
      version: "0.1.0-beta.2",
      publishedAt: "2026-08-11T00:00:00.000Z",
    });
    await update?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns null when no update is available", async () => {
    checkMock.mockResolvedValue(null);
    await expect(tauriStationUpdater.check()).resolves.toBeNull();
  });

  it("closes rejected resources for malformed or non-forward metadata", async () => {
    for (const metadata of [
      { currentVersion: "0.1.0-beta.1", version: "0.1.0-beta.2", date: undefined },
      { currentVersion: "0.1.0-beta.1", version: "0.1.0", date: "2026-08-11T00:00:00.000Z" },
      { currentVersion: "0.1.0-beta.2", version: "0.1.0-beta.1", date: "2026-08-11T00:00:00.000Z" },
    ]) {
      const close = vi.fn().mockResolvedValue(undefined);
      checkMock.mockResolvedValue({ ...metadata, close });
      await expect(tauriStationUpdater.check()).rejects.toThrow(/invalid station update state/);
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("delegates explicit relaunch", async () => {
    relaunchMock.mockResolvedValue(undefined);
    await tauriStationUpdater.relaunch();
    expect(relaunchMock).toHaveBeenCalledOnce();
  });
});
