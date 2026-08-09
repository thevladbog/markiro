import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { READY_URL, observeReadiness } from "../readiness-observer.mjs";

function response(body, { ok = true } = {}) {
  return { ok, json: async () => body };
}

test("returns exactly the sanitized category for healthy, SMTP, storage, and required dependency states", async () => {
  const cases = [
    [{ status: "ok", checks: {} }, true, "ok"],
    [{ status: "degraded", checks: { smtp: { status: "degraded" } } }, true, "smtp_degraded"],
    [{ status: "degraded", checks: { storage: { status: "degraded" } } }, true, "storage_degraded"],
    [
      { status: "unavailable", checks: { database: { status: "unavailable" } } },
      false,
      "required_unavailable",
    ],
  ];
  for (const [body, ok, category] of cases) {
    const result = await observeReadiness({
      domain: "markiro.example",
      fetch: async () => response(body, { ok }),
    });
    assert.deepEqual(result, { category, exitCode: category === "required_unavailable" ? 1 : 0 });
  }
});

test("uses the fixed loopback readiness URL with a two-second abort signal", async () => {
  let call;
  const timeouts = [];
  const result = await observeReadiness({
    domain: "markiro.example",
    fetch: async (url, options) => {
      call = { url, options };
      return response({ status: "ok", checks: {} });
    },
    clock: {
      timeout: (milliseconds) => {
        timeouts.push(milliseconds);
        return AbortSignal.timeout(milliseconds);
      },
    },
  });

  assert.equal(READY_URL, "http://127.0.0.1:8080/health/ready");
  assert.equal(call.url, READY_URL);
  assert.deepEqual(call.options.headers, { Host: "markiro.example" });
  assert.ok(call.options.signal instanceof AbortSignal);
  assert.deepEqual(timeouts, [2_000]);
  assert.deepEqual(result, { category: "ok", exitCode: 0 });
});

test("treats timeout, malformed JSON, and raw failures as required-unavailable without exposing a body", async () => {
  const body = "runtime body must not appear in logs";
  for (const fetch of [
    async () => {
      throw new DOMException("aborted", "TimeoutError");
    },
    async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError(body);
      },
    }),
    async () => ({ ok: false, json: async () => ({ status: "ok", body }) }),
  ]) {
    assert.deepEqual(await observeReadiness({ domain: "markiro.example", fetch }), {
      category: "required_unavailable",
      exitCode: 1,
    });
  }
});

test("fails closed when the production Host authority is absent", async () => {
  assert.deepEqual(
    await observeReadiness({
      domain: null,
      fetch: async () => response({ status: "ok", checks: {} }),
    }),
    {
      category: "required_unavailable",
      exitCode: 1,
    },
  );
});

test("CLI prints one sanitized line and exits nonzero for malformed JSON", () => {
  const script = fileURLToPath(new URL("../readiness-observer.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout.trim(), /^(ok|smtp_degraded|storage_degraded|required_unavailable)$/);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.doesNotMatch(result.stdout, /runtime body must not appear in logs/);
});
