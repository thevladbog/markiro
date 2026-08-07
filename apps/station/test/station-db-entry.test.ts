import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("station SQLite dependency boundary", () => {
  it("evaluates the station mirror without a browser Buffer global", async () => {
    vi.stubGlobal("Buffer", undefined);

    await expect(import("../src/lib/mirror.js")).resolves.toMatchObject({
      applyMigrations: expect.any(Function),
      readOperatorsMirror: expect.any(Function),
    });
  });
});
