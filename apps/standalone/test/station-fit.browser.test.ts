import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The measuring guard of the floor's fit in a real browser: `test/harness/station-fit/measure.mjs`
 * renders «Новая смена», «Рабочее место» and the sign-in at the real terminal's window sizes
 * (1024 x 640 to 1280 x 1024, both themes) and fails on a clipped text or box, a text that spills out
 * of its box or lies over another text or a control, a control under 64 px, cut at a side, outside
 * the window or covered (by the footer, say), a primary under 72 px (84 in a tall window), or a page
 * that scrolls. `measure-others.mjs` runs the same guard over the other floor screens' harness pages
 * (the hub, the work screen, the reprint). It needs Chromium, so it runs only where
 * `PLAYWRIGHT_CORE` names a `playwright-core` (and the loopback is open):
 *
 *   PLAYWRIGHT_CORE=/path/to/playwright-core pnpm --filter @markiro/standalone exec vitest run test/station-fit.browser.test.ts
 *
 * The others' known violations (the work screen below 720 px, the hub's offline banner, the reprint's
 * hint on a 640 px window) are listed in the report of this guard, not hidden: `OTHERS_ALL=1` also
 * runs them as a failing check; by default only the screens this guard fixed are asserted.
 */
const playwright = process.env.PLAYWRIGHT_CORE;

interface Entry extends Record<string, unknown> {
  problems: string[];
  case: string;
}

async function run(script: string, port: number, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [resolve(script), `http://127.0.0.1:${port}`], {
      env: { ...process.env, PLAYWRIGHT_CORE: playwright ?? "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

const problemsOf = (stdout: string) =>
  stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Entry)
    .filter((entry) => entry.problems.length > 0)
    .map(({ width, height, theme, case: name, problems }) => ({
      width,
      height,
      theme,
      case: name,
      problems,
    }));

describe.skipIf(playwright === undefined)("the floor's fit in a browser", () => {
  it("fits the new shift, the workstation setup and the sign-in at the terminal's sizes", async () => {
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
      const own = await run("test/harness/station-fit/measure.mjs", port);
      expect(problemsOf(own.stdout)).toEqual([]);
      expect(own.stderr.slice(0, 600)).toBe("");
      expect(own.status).toBe(0);
      // The hub: the brand gradient behind a photo of every kind, the cards, the header.
      const hub = await run("test/harness/hub-header/measure.mjs", port);
      expect(problemsOf(hub.stdout)).toEqual([]);
      expect(hub.status).toBe(0);
      if (process.env.OTHERS_ALL === "1") {
        const others = await run("test/harness/station-fit/measure-others.mjs", port);
        expect(problemsOf(others.stdout)).toEqual([]);
      }
    } finally {
      await server.close();
    }
  }, 1_800_000);
});
