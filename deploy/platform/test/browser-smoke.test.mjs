import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { browserSmoke } from "../browser-smoke.mjs";

for (const screenshotFails of [false, true]) {
  test(`browser failure preserves diagnostics and original error: screenshotFails=${screenshotFails}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "platform-browser-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const original = new Error("email input did not appear");
    const listeners = {};
    let closed = false;
    let screenshots = 0;
    const page = {
      on: (name, callback) => {
        listeners[name] = callback;
      },
      goto: async () => {
        listeners.pageerror(new Error("module initialization failed"));
        listeners.response({
          url: () => "https://saas-admin.localhost:1234/assets/chunk.js?secret=omit",
          status: () => 404,
        });
        listeners.requestfailed({
          url: () => "https://saas-admin.localhost:1234/assets/app.js?token=never-record",
          resourceType: () => "script",
          failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
        });
      },
      locator: () => ({
        waitFor: async () => {
          throw original;
        },
      }),
      screenshot: async () => {
        screenshots++;
        if (screenshotFails) throw new Error("screenshot unavailable");
      },
    };
    const chromium = {
      launch: async () => ({
        newContext: async () => ({ newPage: async () => page }),
        close: async () => {
          closed = true;
        },
      }),
    };
    await assert.rejects(
      browserSmoke(1234, directory, { chromium }),
      (error) => error === original,
    );
    const raw = await readFile(join(directory, "platform-browser-failure.json"), "utf8");
    assert.equal(raw.includes("never-record"), false);
    assert.deepEqual(JSON.parse(raw), {
      errors: ["module initialization failed"],
      failedResponses: [{ path: "/assets/chunk.js", status: 404 }],
      failedRequests: [
        { path: "/assets/app.js", resourceType: "script", error: "net::ERR_CONNECTION_RESET" },
      ],
    });
    assert.equal(screenshots, 1);
    assert.equal(closed, true);
  });
}
