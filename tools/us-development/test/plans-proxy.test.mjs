import assert from "node:assert/strict";
import test from "node:test";

test("Plan reads reach actual dev and preview proxies with a strict method/path boundary", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const root = "/api/us/traceability/plans";
  const id = "a0000000-0000-4000-8000-000000000001";
  const accepted = [root, `${root}/${id}`, `${root}/${id}/pdf`];
  const rejected = [
    root + "/",
    root + "?",
    root + "?limit=1",
    root + "?a=1&a=2",
    root + "#fragment",
    root + "/unknown",
    root + "/" + id.toUpperCase(),
    `${root}/%61${id.slice(1)}`,
    `${root}/${id}%2Fpdf`,
    `${root}/${id}/pdf/`,
    `${root}/${id}/pdf?download=true`,
    `${root}/${id}/preview`,
    `${root}/${id}/approve`,
    `${root}/${id}/validate`,
    root.replace("plans", "Plans"),
    root.replace("/api/us/", "/api/"),
  ];
  for (const surface of [config.server, config.preview])
    for (const path of accepted) {
      const entry = Object.entries(surface.proxy).find(([pattern]) =>
        new RegExp(pattern).test(path),
      );
      assert.ok(entry, path);
      assert.equal(entry[1].target, "http://localhost:3100");
      assert.equal(entry[1].rewrite(path), path.replace(/^\/api\/us/, ""));
    }
  const plugin = config.plugins.find((p) => p.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let handler;
    plugin[hook]({
      middlewares: {
        use(value) {
          handler = value;
        },
      },
    });
    for (const [method, path, headers, allowed] of [
      ...accepted.map((path) => ["GET", path, {}, true]),
      ...rejected.map((path) => ["GET", path, {}, false]),
      ...["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].flatMap((method) =>
        accepted.map((path) => [method, path, {}, false]),
      ),
      ...accepted.map((path) => ["GET", path, { range: "bytes=0-1" }, false]),
    ]) {
      let next = false,
        status,
        ended = false;
      handler(
        { method, url: path, headers },
        {
          writeHead(code, responseHeaders) {
            status = code;
            assert.equal(responseHeaders["Cache-Control"], "no-store");
          },
          end() {
            ended = true;
          },
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, allowed, `${method} ${path}`);
      assert.equal(ended, !allowed);
      if (!allowed) assert.equal(status, 404);
    }
  }
});
