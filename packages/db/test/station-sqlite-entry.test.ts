import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("browser-safe station SQLite entrypoint", () => {
  it("exports station migrations without evaluating the Postgres root graph", async () => {
    vi.stubGlobal("Buffer", undefined);

    const entry = await import("../src/station-sqlite.js");

    expect(entry.STATION_MIGRATIONS.length).toBeGreaterThan(0);
  });

  it("publishes the narrow station-sqlite package subpath", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    expect(packageJson.exports?.["./station-sqlite"]).toEqual({
      types: "./dist/station-sqlite.d.ts",
      default: "./dist/station-sqlite.js",
    });
  });
});
