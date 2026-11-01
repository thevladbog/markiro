// @vitest-environment node
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const playwright = process.env.PLAYWRIGHT_CORE;
describe.skipIf(playwright === undefined)("Office search and pack geometry in Chromium", () => {
  it("keeps pallet status compact and search readable at phone, tablet and office widths in both themes", async () => {
    const { createServer } = await import("vite");
    const server = await createServer({
      root: process.cwd(),
      logLevel: "silent",
      server: { host: "127.0.0.1", port: 0 },
    });
    await server.listen();
    try {
      const address = server.httpServer?.address();
      if (typeof address !== "object" || address === null) throw new Error("No browser test port");
      const result = await new Promise<{ status: number | null; output: string }>(
        (done, reject) => {
          const child = spawn(
            process.execPath,
            [resolve("test/harness/office-search/measure.mjs"), `http://127.0.0.1:${address.port}`],
            { env: { ...process.env, PLAYWRIGHT_CORE: playwright } },
          );
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (status) => done({ status, output }));
        },
      );
      expect(result.output).toContain('"problems":[]');
      expect(result.status).toBe(0);
    } finally {
      await server.close();
    }
  }, 120_000);
});
