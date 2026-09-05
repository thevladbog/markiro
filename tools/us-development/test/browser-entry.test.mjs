import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const path = "apps/admin/vite.us.config.ts";

test("US CI builds shared UI before importing its compiled components in tests", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  const steps = workflow.jobs.isolation.steps;
  const build = steps.findIndex((step) => step.run?.includes("--filter @markiro/ui build"));
  const testIndex = steps.findIndex((step) => step.run?.includes("test/us-app.test.tsx"));
  assert.ok(build >= 0 && testIndex > build, "shared UI must be built before UI tests");
});

test("US generated output is excluded from source lint after a build", async () => {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint();
  assert.equal(await eslint.isPathIgnored("apps/admin/dist-us/assets/index.js"), true);
  assert.equal(await eslint.isPathIgnored("apps/admin/src/us/app.tsx"), false);
});

test("US browser has a separate explicit config, entry and output", async () => {
  const source = readFileSync(path, "utf8");
  assert.ok(source.length > 0);
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "development");
  assert.match(config.root, /apps\/admin\/us$/);
  assert.equal(config.envDir, false);
  assert.deepEqual(config.envPrefix, []);
  assert.equal(config.publicDir, false);
  assert.match(config.build.outDir, /apps\/admin\/dist-us$/);
  assert.equal(config.build.emptyOutDir, true);
  assert.equal(config.server.host, "localhost");
  assert.equal(config.server.port, 5174);
  assert.equal(config.server.strictPort, true);
  assert.equal(config.preview.host, "localhost");
  assert.equal(config.preview.port, 5174);
  assert.equal(config.preview.strictPort, true);
  assert.equal(config.define["import.meta.env.VITE_DEPLOYMENT_EDITION"], '"US"');
  const html = readFileSync("apps/admin/us/index.html", "utf8");
  assert.match(html, /lang="en-US"/);
  assert.match(html, /src="\.\/main\.tsx"/);
  assert.match(readFileSync("apps/admin/us/main.tsx", "utf8"), /\.\.\/src\/us\/main\.js/);
  assert.doesNotMatch(html, /src="\/src\/main\.tsx"/);
  const entry = readFileSync("apps/admin/src/us/main.tsx", "utf8");
  assert.match(entry, /\.\/app\.js/);
  assert.doesNotMatch(entry, /i18n\/index|\.\.\/app|auth\/client/);
});

test("US builds reject accidental imports of RU application code", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const boundary = config.plugins.find((plugin) => plugin.name === "us-entry-boundary");
  assert.ok(boundary, "US build must enforce its source boundary");
  const context = {
    error(message) {
      throw new Error(message);
    },
  };
  for (const moduleId of [
    "src/app.tsx",
    "src/auth/client.ts",
    "src/i18n/index.ts",
    "src/api/client.ts",
  ]) {
    assert.throws(
      () => boundary.transform.call(context, "", `${config.root.slice(0, -3)}/${moduleId}`),
      /US entry cannot import/,
    );
  }
  for (const moduleId of ["src/us/app.tsx", "src/assets/markiro-logo-on-dark.svg"]) {
    assert.doesNotThrow(() =>
      boundary.transform.call(context, "", `${config.root.slice(0, -3)}/${moduleId}`),
    );
  }
});

test("US browser config rejects missing/wrong edition and hosted modes", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  for (const [env, mode] of [
    [{}, "development"],
    [{ VITE_DEPLOYMENT_EDITION: "RU" }, "development"],
    [{ VITE_DEPLOYMENT_EDITION: "US" }, "production"],
    [{ VITE_DEPLOYMENT_EDITION: "US" }, "staging"],
    [{ VITE_DEPLOYMENT_EDITION: "US", MARKIRO_DEPLOYMENT_EDITION: "RU" }, "test"],
  ])
    assert.throws(() => createUsAdminConfig(env, mode), /US local browser/);
});

test("US proxy never forwards RU routes and preserves configured API Host", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const routes = Object.entries(config.server.proxy);
  for (const path of [
    "/api/auth/get-session",
    "/api/boxes",
    "/api/us/boxes",
    "/api/us/deployment-evil",
    "/api/us/traceability/parties-extra",
    "/api/us/traceability/access?forged=1",
    "/api/us/traceability/access/",
    "/api/us/traceability/locations/invalid-id",
    "/api/us/traceability/parties/../profile",
    "/api/us/traceability/parties/%2e%2e/profile",
    "/api/us/traceability/parties/a0000000-0000-4000-8000-000000000001/exports",
    "/api/us/traceability/lots",
  ])
    assert.equal(
      routes.some(([pattern]) => new RegExp(pattern.slice(1)).test(path)),
      false,
    );
  for (const [input, output] of [
    ["/api/us-auth/get-session", "/api/us-auth/get-session"],
    ["/api/us/deployment", "/deployment"],
    ["/api/us/traceability/profile", "/traceability/profile"],
    ["/api/us/traceability/access", "/traceability/access"],
    ["/api/us/traceability/parties?limit=20", "/traceability/parties?limit=20"],
    [
      "/api/us/traceability/locations?roles=supplier&roles=receive_at",
      "/traceability/locations?roles=supplier&roles=receive_at",
    ],
    [
      "/api/us/traceability/parties/a0000000-0000-4000-8000-000000000001",
      "/traceability/parties/a0000000-0000-4000-8000-000000000001",
    ],
    [
      "/api/us/traceability/locations/b0000000-0000-4000-8000-000000000002",
      "/traceability/locations/b0000000-0000-4000-8000-000000000002",
    ],
  ]) {
    const match = routes.find(([pattern]) => new RegExp(pattern.slice(1)).test(input));
    assert.ok(match);
    assert.equal(match[1].target, "http://localhost:3100");
    assert.equal(match[1].changeOrigin, true);
    assert.equal(match[1].rewrite?.(input) ?? input, output);
  }
});
