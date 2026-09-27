import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, loadMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  loadMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/plugin-sql", () => ({ default: { load: loadMock } }));

beforeEach(() => {
  // `sqlite.ts` caches the open database for the process; every test needs a
  // fresh module instance.
  vi.resetModules();
  invokeMock.mockReset();
  loadMock.mockReset();
});

describe("tauriExecutor", () => {
  it("opens the database at the URL the Rust side resolved, once", async () => {
    const url = "sqlite:C:\\Users\\op\\AppData\\Local\\app.markiro.station\\station-mirror.db";
    invokeMock.mockImplementation(async (command: string) =>
      command === "station_database_url" ? url : undefined,
    );
    const database = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn().mockResolvedValue([]),
    };
    loadMock.mockResolvedValue(database);
    const { tauriExecutor } = await import("../src/lib/sqlite.js");

    await tauriExecutor.run("SELECT 1");
    await tauriExecutor.all("SELECT 2");

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("station_database_url");
    expect(loadMock).toHaveBeenCalledTimes(1);
    expect(loadMock).toHaveBeenCalledWith(url);
    expect(database.execute).toHaveBeenCalledWith("SELECT 1", []);
    expect(database.select).toHaveBeenCalledWith("SELECT 2", []);
  });

  it("never falls back to the relative URL the plugin resolves in the roaming folder", async () => {
    invokeMock.mockRejectedValue(new Error("station storage was not resolved"));
    const { tauriExecutor } = await import("../src/lib/sqlite.js");

    await expect(tauriExecutor.run("SELECT 1")).rejects.toThrow("station storage was not resolved");
    expect(loadMock).not.toHaveBeenCalled();
  });
});
