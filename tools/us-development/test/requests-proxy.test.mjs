import assert from "node:assert/strict";
import test from "node:test";
import { createUsAdminConfig } from "../../../apps/admin/vite.us.config.ts";

const id = "a0000000-0000-4000-8000-000000000001";
const root = "/api/us/traceability";
const allowed = [
  ["GET", "/requests"],
  ["POST", "/requests"],
  ["GET", `/requests/${id}`],
  ["PATCH", `/requests/${id}`],
  ...["close", "validate", "acknowledge-warnings", "prepare"].map((action) => [
    "POST",
    `/requests/${id}/${action}`,
  ]),
  ["GET", `/requests/${id}/runs`],
  ["GET", `/export-runs/${id}`],
  ["GET", `/export-runs/${id}/attempts`],
  ["POST", `/export-runs/${id}/retry`],
  ...["xlsx", "plan_pdf", "validation_report", "request_report", "manifest", "package_zip"].map(
    (kind) => ["GET", `/export-runs/${id}/artifacts/${kind}`],
  ),
];
const denied = [
  ...allowed.flatMap(([method, path]) => [
    ["HEAD", path],
    ["DELETE", path],
    [method, path + "/"],
    [method, path + "?tenant=x"],
    [method, path.replace(id, id.toUpperCase())],
    [method, path.replace(id, id.replace("a", "%61"))],
  ]),
  ["PUT", "/requests"],
  ["POST", `/requests/${id}/runs`],
  ["GET", `/requests/${id}/close`],
  ["GET", `/export-runs/${id}/retry`],
  ...[
    "XYZ",
    "/unknown",
    `/%2f${id}`,
    `/${id}/unknown`,
    `/${id}?limit=1`,
    "?limit=01",
    "?limit=51",
    "?offset=10001",
    "?limit=1&limit=2",
    "?limit=1&%6cimit=2",
    "?actor=x",
    "?",
    "?limit=1#x",
    "?limit=1&&offset=0",
  ].map((suffix) => ["GET", "/requests" + suffix]),
  ["GET", `/export-runs/${id}/artifacts/SHA256SUMS`],
  ["GET", `/export-runs/${id}/artifacts/private-key`],
  ["GET", `/export-runs/${id}/artifacts/xlsx?key=private`],
  ["POST", "/requests?limit=1"],
  ["POST", `/requests/${id}/prepare?limit=1`],
  ["GET", `/requests/${id}/runs?requestNumber=REQ`],
  ["GET", `/export-runs/${id}/attempts?status=open`],
];

for (const hook of ["configureServer", "configurePreviewServer"])
  test(`Requests ${hook} denies aliases before upstream and preserves exact rewrites`, () => {
    const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
    const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
    let middleware;
    guard[hook]({
      middlewares: {
        use(handler) {
          middleware = handler;
        },
      },
    });
    const routes = Object.entries(config.server.proxy);
    const check = (method, suffix, want, range = false) => {
      let upstreamHits = 0;
      let status;
      middleware(
        { method, url: root + suffix, headers: range ? { range: "bytes=0-2" } : {} },
        {
          writeHead(value, headers) {
            status = value;
            assert.equal(headers["Cache-Control"], "no-store");
          },
          end() {},
        },
        () => {
          const route = routes.find(([pattern]) => new RegExp(pattern).test(root + suffix));
          assert.ok(route, suffix);
          assert.equal(route[1].rewrite(root + suffix), "/traceability" + suffix);
          assert.equal(route[1].target, "http://localhost:3100");
          assert.equal(route[1].changeOrigin, true);
          upstreamHits++;
        },
      );
      assert.equal(upstreamHits, want ? 1 : 0, `${method} ${suffix} Range=${range}`);
      assert.equal(status, want ? undefined : 404);
    };
    for (const [method, suffix] of allowed) {
      check(method, suffix, true);
      check(method, suffix, false, true);
      for (const wrongMethod of ["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD"])
        if (
          !allowed.some(
            ([acceptedMethod, path]) => acceptedMethod === wrongMethod && path === suffix,
          )
        )
          check(wrongMethod, suffix, false);
    }
    for (const [method, suffix] of denied) {
      // Collection paths contain no ID to mutate; those unchanged aliases are allowed.
      if (allowed.some(([m, path]) => m === method && path === suffix)) continue;
      check(method, suffix, false);
    }
    for (const path of [
      "/requests?requestNumber=REQ+1&status=open&limit=50&offset=10000",
      `/requests/${id}/runs?%6cimit=1&offset=0`,
      `/export-runs/${id}/attempts?limit=50`,
    ])
      check("GET", path, true);
  });
