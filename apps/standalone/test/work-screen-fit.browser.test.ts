import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The structural overflow guard in a real browser: `test/harness/work-fit/measure.mjs` renders
 * the work screen's real components (aggregation, pallets, plain, check, capacities 3 to 48,
 * photo kinds) at 1280 and 1024 wide and 1024, 960, 900, 800 and 720 high, and fails on a page
 * scroll, an overflowing box button or panel, a clipped history row, a clipped code line, a
 * clipped cell serial, or a photo frame that is not as tall as its band. It needs Chromium, so
 * it runs only where `PLAYWRIGHT_CORE` names a `playwright-core` (and the loopback is open):
 *
 *   PLAYWRIGHT_CORE=/path/to/playwright-core pnpm --filter @markiro/standalone exec vitest run test/work-screen-fit.browser.test.ts
 */
const playwright = process.env.PLAYWRIGHT_CORE;

describe.skipIf(playwright === undefined)("the work screen's fit in a browser", () => {
  it("has no overflow, no clipped row and no unfit photo at the real window sizes", async () => {
    const { createServer } = await import("vite");
    const server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { port: 0, host: "127.0.0.1" },
    });
    await server.listen();
    try {
      const address = server.httpServer?.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      // Asynchronous: the dev server lives in this process and must answer the browser meanwhile.
      const run = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (done) => {
          const child = spawn(
            process.execPath,
            [resolve("test/harness/work-fit/measure.mjs"), `http://127.0.0.1:${port}`],
            { env: { ...process.env, PLAYWRIGHT_CORE: playwright ?? "" } },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
          child.on("close", (status) => done({ status, stdout, stderr }));
        },
      );
      const problems = run.stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { problems: string[] } & Record<string, unknown>)
        .filter((entry) => entry.problems.length > 0);
      expect(problems).toEqual([]);
      expect(run.stderr.slice(0, 600)).toBe("");
      expect(run.status).toBe(0);
    } finally {
      await server.close();
    }
  }, 240_000);
});
