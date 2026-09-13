import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

function config(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "PRODUCT_LABELS_ADMIN_PORT",
    "PRODUCT_LABELS_STATION_PORT",
    "STATION_PRODUCT_LABELS_URL",
  ])
    delete env[key];
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import config from ${JSON.stringify(new URL("../product-labels.playwright.config.ts", import.meta.url).href)};
    console.log(JSON.stringify({ servers: config.webServer, baseURL: config.use?.baseURL }));
  `,
    ],
    { env: { ...env, ...overrides }, encoding: "utf8" },
  );
  return result;
}

for (const key of ["PRODUCT_LABELS_ADMIN_PORT", "PRODUCT_LABELS_STATION_PORT"]) {
  for (const value of ["", "  ", "abc", "1.5", "0", "-1", "65536"]) {
    test(`${key} rejects invalid TCP port ${JSON.stringify(value)}`, () => {
      const result = config({ [key]: value });
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(key));
    });
  }
}
test("default navigation and server use the default Station port", () => {
  const result = config();
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.baseURL, "http://127.0.0.1:43182");
  assert.equal(value.servers[1].url, value.baseURL);
});
test("trimmed custom ports drive both startup and navigation", () => {
  const result = config({
    PRODUCT_LABELS_ADMIN_PORT: " 1 ",
    PRODUCT_LABELS_STATION_PORT: " 65535 ",
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.match(value.servers[0].command, /--port 1 --strictPort/);
  assert.match(value.servers[1].command, /--port 65535 --strictPort/);
  assert.equal(value.baseURL, "http://127.0.0.1:65535");
});
test("explicit navigation URL survives a configured local server port", () => {
  const result = config({
    PRODUCT_LABELS_STATION_PORT: "43482",
    STATION_PRODUCT_LABELS_URL: "http://example.test/station",
  });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout);
  assert.equal(value.baseURL, "http://example.test/station");
  assert.match(value.servers[1].command, /--port 43482 --strictPort/);
});
