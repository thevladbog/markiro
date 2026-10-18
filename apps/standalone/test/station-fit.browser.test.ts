import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The measuring guard of the station floor's fit in a real browser, over the real terminal's window
 * sizes (1024 x 640 to 1280 x 1024, both themes): a 1280 x 1024 panel at Windows 125 % gives the app
 * about 1024 x 640-720 CSS px. It fails on a clipped text or box, a text that spills out of its box
 * or lies over another text or a control, a control under 64 px, cut at a side, outside the window
 * or covered (by the footer, say), a primary under 72 px (84 px in a tall window), or a page that
 * scrolls. Three scripts, one rule set (`measure-fit.ts`):
 *   - `measure.mjs`: «Новая смена», «Рабочее место» (all four tabs, the printer form with its
 *     keypad, the A4 test, the version block of «Станция») and the sign-in;
 *   - `measure-others.mjs`: the hub and its header, the work screen (aggregation, pallets, plain,
 *     «Проверка», long and big texts), the warehouse reprint in all its states;
 *   - `measure-screens.mjs`: the work screen's stages (exceptions, the close and the closed shift,
 *     the full scan history, the labels' history) and the re-confirmation card, where nothing may
 *     scroll but a list long by nature and no control may wait below the fold.
 * It needs Chromium, so it runs only where `PLAYWRIGHT_CORE` names a `playwright-core` (and the
 * loopback is open; on macOS the sandbox is off):
 *
 *   PLAYWRIGHT_CORE=/path/to/playwright-core pnpm --filter @markiro/standalone exec vitest run test/station-fit.browser.test.ts
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
  it("fits every station screen at the terminal's sizes", async () => {
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
      // The hub's cases, the work screen and the reprint, on the whole matrix.
      const others = await run("test/harness/station-fit/measure-others.mjs", port);
      expect(problemsOf(others.stdout)).toEqual([]);
      expect(others.status).toBe(0);
      // The work screen's stages and the re-confirmation card.
      const screens = await run("test/harness/station-fit/measure-screens.mjs", port);
      expect(problemsOf(screens.stdout)).toEqual([]);
      expect(screens.status).toBe(0);
    } finally {
      await server.close();
    }
  }, 3_600_000);
});
