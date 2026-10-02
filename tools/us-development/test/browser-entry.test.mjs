import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const path = "apps/admin/vite.us.config.ts";

test("US CI owns readiness rules, strict contract and disposable-DB HTTP coverage", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.jobs), ["isolation"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.isolation;
  assert.equal(job.environment, undefined);
  for (const suite of [
    "readiness-sweep.test.ts",
    "us-readiness-sweep.test.ts",
    "us-readiness-query.test.ts",
    "us-readiness-evidence.e2e.test.ts",
    "us-readiness-assessment.e2e.test.ts",
    "us-readiness-http.e2e.test.ts",
    "us-readiness-client.test.ts",
    "us-readiness-view.test.tsx",
    "us-readiness-picker.test.tsx",
    "us-readiness-navigation.test.tsx",
  ]) {
    const step = job.steps.find((entry) => entry.run?.includes(`test/${suite}`));
    assert.ok(step, suite);
    assert.equal(step.if, undefined);
    if (suite.includes(".e2e.")) {
      const url = new URL(step.env.US_TEST_DATABASE_URL);
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.port, "55432");
      assert.equal(url.pathname, "/markiro_us_dev");
      assert.equal(step.env.DATABASE_URL, undefined);
    }
  }
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /secrets\.|docker push|gh workflow run|packages:write/,
  );
});

test("US readiness dev/preview proxy accepts only exact GET with four unique approved keys", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const id = "a0000000-0000-4000-8000-000000000001";
  const route = "/api/us/traceability/readiness";
  const accepted = [
    route,
    `${route}?lotId=${id}`,
    `${route}?productId=${id}`,
    `${route}?eventDateFrom=2026-09-01&eventDateTo=2026-09-28`,
    `${route}?productId=${id}&eventDateTo=2026-09-28&lotId=${id}&eventDateFrom=2026-09-01`,
  ];
  const rejected = [
    `${route}/`,
    `${route}/extra`,
    `${route}?`,
    `${route}?tenantId=${id}`,
    `${route}?profileCode=US_GENERIC_LOT_TRACEABILITY`,
    `${route}?limit=10`,
    `${route}?lotId=invalid`,
    `${route}?productId=invalid`,
    `${route}?lotId[]=x`,
    `${route}?lotId=${id}&lotId=${id}`,
    `${route}?lotId=${id}&%6cotId=${id}`,
    `${route}?eventDateFrom=2026-09-01&eventDateTo=2026-09-28&eventDateFrom=2026-09-01`,
    `${route}?eventDateFrom=2026-09-01&%65ventDateFrom=2026-09-01`,
    `${route}?eventDateFrom=2026-9-1&eventDateTo=2026-09-28`,
    `${route}?eventDateFrom=2026-09-01T00%3A00%3A00Z&eventDateTo=2026-09-28`,
    route.replace("/api/us/", "/api/"),
    route.replace("readiness", "Readiness"),
    "/api/boxes",
    "/api/us/boxes",
  ];
  for (const surface of [config.server, config.preview]) {
    const entries = Object.entries(surface.proxy);
    for (const url of accepted) {
      const entry = entries.find(([pattern]) => new RegExp(pattern).test(url));
      assert.ok(entry, url);
      assert.equal(entry[1].target, "http://localhost:3100");
      assert.equal(entry[1].changeOrigin, true);
      assert.equal(entry[1].rewrite(url), url.replace(/^\/api\/us/, ""));
    }
    for (const url of rejected)
      assert.equal(
        entries.some(([pattern]) => new RegExp(pattern).test(url)),
        false,
        url,
      );
  }
  const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let middleware;
    guard[hook]({
      middlewares: {
        use(handler) {
          middleware = handler;
        },
      },
    });
    for (const [method, url, allowed] of [
      ...accepted.map((url) => ["GET", url, true]),
      ...rejected.map((url) => ["GET", url, false]),
      ...["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].flatMap((method) =>
        accepted.map((url) => [method, url, false]),
      ),
    ]) {
      let next = false,
        status;
      middleware(
        { method, url },
        {
          writeHead(value, headers) {
            status = value;
            assert.equal(headers["Cache-Control"], "no-store");
          },
          end() {},
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, allowed, `${method} ${url}`);
      assert.equal(status, allowed ? undefined : 404);
    }
  }
});

test("US CI owns search and card suites on disposable PostgreSQL without publication", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  assert.deepEqual(Object.keys(workflow.jobs), ["isolation"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const job = workflow.jobs.isolation;
  assert.equal(job.environment, undefined);
  for (const suite of [
    "us-search-lot-card.test.ts",
    "us-trace-search-query.test.ts",
    "us-trace-search.e2e.test.ts",
    "us-lot-card.e2e.test.ts",
    "us-search-lot-card-http.e2e.test.ts",
  ]) {
    const step = job.steps.find((entry) => entry.run?.includes(`test/${suite}`));
    assert.ok(step, suite);
    assert.equal(step.if, undefined);
    if (suite.includes(".e2e.")) assert.equal(new URL(step.env.US_TEST_DATABASE_URL).port, "55432");
  }
  assert.doesNotMatch(
    JSON.stringify(workflow),
    /secrets\.|docker push|gh workflow run|packages:write/,
  );
  const transport = job.steps.findIndex((step) =>
    step.run?.includes("test/search-transport.smoke.mjs"),
  );
  const build = job.steps.findIndex((step) => step.run === "pnpm --filter @markiro/admin build:us");
  assert.ok(transport > build, "dev/preview transport must run against the built US entry");
  assert.equal(job.steps[transport].if, undefined);
});

test("US search/card proxy allows only bounded exact GET paths and query keys", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const id = "a0000000-0000-4000-8000-000000000001";
  const search = "/api/us/traceability/search";
  const card = `/api/us/traceability/lots/${id}/card`;
  const accepted = [
    search,
    `${search}?limit=100&cursor=abc_-`,
    `${search}?tlcList=${encodeURIComponent(JSON.stringify(["ABC", "Два"]))}`,
    `${search}?q=ABC&tlc=ABC&tlcFrom=A&tlcTo=Z&productText=Food`,
    `${search}?lotId=${id}&productId=${id}&sourceLocationId=${id}&locationId=${id}`,
    `${search}?eventType=receiving&eventDateFrom=2026-01-01&eventDateTo=2026-09-27&status=active`,
    `${search}?sourceReferenceValue=https%3A%2F%2Fexample.test&documentType=other&documentNumber=A%2F1&sscc=000123456789012343`,
    card,
    `${card}/evidence`,
    `${card}/evidence?limit=50&cursor=abc_-`,
  ];
  const rejected = [
    `${search}/extra`,
    `${search}?tenantId=x`,
    `${search}?limit=101`,
    `${search}?limit=1&limit=2`,
    `${search}?limit=1&%6cimit=2`,
    `${search}?tlcList=A&tlcList=B`,
    `${search}?cursor=a&cursor=b`,
    `${search}?lotId=invalid`,
    `${card}?limit=1`,
    `${card}/extra`,
    card.replace(id, "invalid"),
    `${card}/evidence?limit=51`,
    `${card}/evidence?tenantId=x`,
    `${card}/evidence?cursor=a&cursor=b`,
    "/api/traceability/search",
    "/api/us/boxes",
  ];
  const entries = Object.entries(config.server.proxy);
  for (const status of ["active", "consumed", "shipped", "quarantined", "recalled", "archived"]) {
    accepted.push(`${search}?status=${status}`);
  }
  for (const url of accepted) {
    const route = entries.find(([pattern]) => new RegExp(pattern).test(url));
    assert.ok(route, url);
    assert.equal(route[1].target, "http://localhost:3100");
    assert.equal(route[1].rewrite(url), url.replace(/^\/api\/us/, ""));
  }
  for (const url of rejected)
    assert.equal(
      entries.some(([pattern]) => new RegExp(pattern).test(url)),
      false,
      url,
    );
  const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let middleware;
    guard[hook]({
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    });
    for (const [method, url, allowed] of [
      ...accepted.map((url) => ["GET", url, true]),
      ...rejected.map((url) => ["GET", url, false]),
      ...["POST", "PUT", "PATCH", "DELETE", "HEAD"].flatMap((method) =>
        accepted.map((url) => [method, url, false]),
      ),
    ]) {
      let next = false,
        status;
      middleware(
        { method, url },
        {
          writeHead: (value) => {
            status = value;
          },
          end() {},
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, allowed, `${method} ${url}`);
      assert.equal(status, allowed ? undefined : 404);
    }
  }
});

test("Receiving read-only observer recognizes only a strict bounded genealogy POST", async () => {
  const { isBoundedGenealogyRead } = await import("./genealogy-read-observer.mjs");
  const base = "http://localhost:5174/api/us/traceability";
  const id = "a0000000-0000-4000-8000-000000000001";
  const body = {
    startLotId: id,
    mode: "current",
    direction: "upstream",
    maxDepth: 4,
    maxNodes: 100,
  };
  const request = (path, data = body, method = "POST") => ({
    url: () => base + path,
    method: () => method,
    postDataJSON: () => data,
  });
  assert.equal(isBoundedGenealogyRead(request("/transformation/genealogy/query"), base), true);
  for (const candidate of [
    request(`/transformation/${id}/finalize`),
    request(`/lots/${id}/cases`),
    request("/transformation/genealogy/query/extra"),
    request("/transformation/genealogy/query?tenantId=x"),
    request("/transformation/genealogy/query", { ...body, tenantId: id }),
    request("/transformation/genealogy/query", { ...body, maxNodes: 101 }),
    request("/transformation/genealogy/query", { ...body, startLotId: "invalid" }),
    request("/transformation/genealogy/query", body, "PUT"),
  ])
    assert.equal(isBoundedGenealogyRead(candidate, base), false);
});

test("US dev and preview middleware reject unknown RU API routes before fallback", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let middleware;
    guard[hook]({
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    });
    for (const url of [
      "/api/auth/get-session",
      "/api/boxes",
      "/api/us/boxes",
      "/api/us/traceability/events?type=shipping&tenantId=x",
    ]) {
      let ended = false;
      middleware(
        { url },
        {
          writeHead(status, headers) {
            assert.equal(status, 404);
            assert.deepEqual(headers, { "Cache-Control": "no-store" });
          },
          end() {
            ended = true;
          },
        },
        () => assert.fail(`Unknown route reached fallback: ${url}`),
      );
      assert.equal(ended, true);
    }
  }
});

test("US CI owns Events and Transformation browser contracts without release capabilities", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  const steps = workflow.jobs.isolation.steps;
  const build = steps.findIndex((step) => step.run?.includes("--filter @markiro/ui build"));
  for (const name of [
    "us-events-client.test.ts",
    "us-transformation-client.test.ts",
    "us-cases-client.test.ts",
    "us-events-ui.test.tsx",
    "us-transformation-editor.test.tsx",
    "us-transformation-readiness.test.tsx",
    "us-transformation-finalization.test.tsx",
    "us-transformation-detail.test.tsx",
    "us-transformation-history.test.tsx",
    "us-transformation-cases.test.tsx",
    "us-transformation-genealogy.test.tsx",
  ]) {
    const index = steps.findIndex((step) => step.run?.includes(`test/${name}`));
    assert.ok(index > build, `${name} must run after shared UI build`);
    assert.equal(steps[index].if, undefined);
  }
  const entry = steps.find(
    (step) => step.name === "Verify local-only browser entry and strict proxy",
  );
  assert.match(
    entry?.run ?? "",
    /node --test tools\/us-development\/test\/browser-entry\.test\.mjs/,
  );
  assert.equal(entry.if, undefined);
  const usBuild = steps.find((step) => step.run === "pnpm --filter @markiro/admin build:us");
  assert.equal(usBuild.env.VITE_DEPLOYMENT_EDITION, "US");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(workflow.jobs.isolation.environment, undefined);
  const commands = steps.map((step) => step.run ?? "").join("\n");
  assert.doesNotMatch(
    commands,
    /gh workflow run|workflow_dispatch|docker push|deploy-production|release-images/,
  );
});

test("US CI builds shared UI before importing its compiled components in tests", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  const steps = workflow.jobs.isolation.steps;
  const build = steps.findIndex((step) => step.run?.includes("--filter @markiro/ui build"));
  const testIndex = steps.findIndex((step) => step.run?.includes("test/us-app.test.tsx"));
  assert.ok(build >= 0 && testIndex > build, "shared UI must be built before UI tests");
  for (const name of ["us-receiving-csv-client.test.ts", "us-receiving-csv-ui.test.tsx"]) {
    const csvTest = steps.findIndex((step) => step.run?.includes(`test/${name}`));
    assert.ok(csvTest > build, `${name} must run after the shared UI build`);
    assert.equal(steps[csvTest].if, undefined);
  }
});

test("US CI runs saved Receiving CSV codec and audited endpoint checks", () => {
  const workflow = load(readFileSync(".github/workflows/us-development.yml", "utf8"));
  const commands = workflow.jobs.isolation.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /test\/us-receiving-csv-export\.test\.ts/);
  assert.match(commands, /test\/us-receiving-csv-export\.e2e\.test\.ts/);
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
    "/api/us/traceability/receiving/imports/preview?tenant=x",
    "/api/us/traceability/receiving/imports/invalid-id",
    "/api/us/traceability/receiving/imports/a0000000-0000-4000-8000-000000000001/apply/extra",
    "/api/us/traceability/receiving/invalid-id/export.csv?expectedDraftVersion=1&expectedLifecycleVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedDraftVersion=01&expectedLifecycleVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedLifecycleVersion=1&expectedDraftVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedDraftVersion=1&expectedLifecycleVersion=1&tenantId=x",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedDraftVersion=1&expectedDraftVersion=2&expectedLifecycleVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv/extra?expectedDraftVersion=1&expectedLifecycleVersion=1",
    "/api/us/traceability/receiving/invalid-id",
    "/api/us/traceability/receiving/invalid-id/readiness?expectedDraftVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=01",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=1&tenantId=x",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness/finalize?expectedDraftVersion=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize?x=1",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize/extra",
    "/api/us/traceability/receiving?status=voided",
    "/api/us/traceability/receiving?status=draft&status=finalized",
    "/api/us/traceability/receiving?history=current&history=all",
    "/api/us/traceability/receiving?history=latest",
    "/api/us/traceability/receiving?limit=50&tenantId=x",
    "/api/us/traceability/receiving?offset=100001",
    "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001?tenantId=x",
    "/api/us/traceability/reference-documents/a0000000-0000-4000-8000-000000000001/attachments",
    "/api/us/deployment-evil",
    "/api/us/traceability/parties-extra",
    "/api/us/traceability/access?forged=1",
    "/api/us/traceability/access/",
    "/api/us/traceability/locations/invalid-id",
    "/api/us/traceability/parties/../profile",
    "/api/us/traceability/parties/%2e%2e/profile",
    "/api/us/traceability/parties/a0000000-0000-4000-8000-000000000001/exports",
    "/api/us/traceability/lots/invalid-id",
    "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/source/unlock",
    "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001?tenantId=x",
    "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/status?context=system",
    "/api/us/traceability/products",
    "/api/us/traceability/products/invalid-id",
    "/api/us/traceability/products/a0000000-0000-4000-8000-000000000001/exports",
    "/api/us/traceability/products/a0000000-0000-4000-8000-000000000001?tenantId=x",
    "/api/us/traceability/catalog/products-extra",
    "/api/us/traceability/catalog/products/invalid-id",
    "/api/us/traceability/catalog/products/a0000000-0000-4000-8000-000000000001/traceability",
    "/api/us/traceability/catalog/products/%2e%2e/profile",
  ])
    assert.equal(
      routes.some(([pattern]) => new RegExp(pattern.slice(1)).test(path)),
      false,
    );
  for (const [input, output] of [
    [
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedDraftVersion=1&expectedLifecycleVersion=2",
      "/traceability/receiving/a0000000-0000-4000-8000-000000000001/export.csv?expectedDraftVersion=1&expectedLifecycleVersion=2",
    ],
    ["/api/us/traceability/receiving/imports/preview", "/traceability/receiving/imports/preview"],
    [
      "/api/us/traceability/receiving/imports/a0000000-0000-4000-8000-000000000001",
      "/traceability/receiving/imports/a0000000-0000-4000-8000-000000000001",
    ],
    [
      "/api/us/traceability/receiving/imports/a0000000-0000-4000-8000-000000000001/apply",
      "/traceability/receiving/imports/a0000000-0000-4000-8000-000000000001/apply",
    ],
    [
      "/api/us/traceability/receiving?limit=50&offset=0",
      "/traceability/receiving?limit=50&offset=0",
    ],
    ["/api/us/traceability/receiving", "/traceability/receiving"],
    [
      "/api/us/traceability/receiving?status=void&history=all&search=REC&limit=50&offset=0",
      "/traceability/receiving?status=void&history=all&search=REC&limit=50&offset=0",
    ],
    [
      "/api/us/traceability/receiving?status=amended&history=current",
      "/traceability/receiving?status=amended&history=current",
    ],
    [
      "/api/us/traceability/receiving?status=finalized&limit=50&offset=0",
      "/traceability/receiving?status=finalized&limit=50&offset=0",
    ],
    [
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize",
      "/traceability/receiving/a0000000-0000-4000-8000-000000000001/finalize",
    ],
    [
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=12",
      "/traceability/receiving/a0000000-0000-4000-8000-000000000001/readiness?expectedDraftVersion=12",
    ],
    [
      "/api/us/traceability/receiving/a0000000-0000-4000-8000-000000000001",
      "/traceability/receiving/a0000000-0000-4000-8000-000000000001",
    ],
    [
      "/api/us/traceability/reference-documents?search=BOL",
      "/traceability/reference-documents?search=BOL",
    ],
    ["/api/us/traceability/reference-documents", "/traceability/reference-documents"],
    [
      "/api/us/traceability/reference-documents/a0000000-0000-4000-8000-000000000001",
      "/traceability/reference-documents/a0000000-0000-4000-8000-000000000001",
    ],
    ["/api/us/traceability/lots?search=A&limit=50", "/traceability/lots?search=A&limit=50"],
    ["/api/us/traceability/lots", "/traceability/lots"],
    [
      "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001",
      "/traceability/lots/a0000000-0000-4000-8000-000000000001",
    ],
    [
      "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/source",
      "/traceability/lots/a0000000-0000-4000-8000-000000000001/source",
    ],
    [
      "/api/us/traceability/lots/a0000000-0000-4000-8000-000000000001/status",
      "/traceability/lots/a0000000-0000-4000-8000-000000000001/status",
    ],
    ["/api/us-auth/get-session", "/api/us-auth/get-session"],
    ["/api/us/deployment", "/deployment"],
    ["/api/us/traceability/profile", "/traceability/profile"],
    ["/api/us/traceability/access", "/traceability/access"],
    [
      "/api/us/traceability/products/a0000000-0000-4000-8000-000000000001",
      "/traceability/products/a0000000-0000-4000-8000-000000000001",
    ],
    ["/api/us/traceability/catalog/products?limit=50", "/traceability/catalog/products?limit=50"],
    [
      "/api/us/traceability/catalog/products/a0000000-0000-4000-8000-000000000001",
      "/traceability/catalog/products/a0000000-0000-4000-8000-000000000001",
    ],
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

test("US lifecycle proxy admits only exact UUID commands and bounded unique history/basis pages", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const routes = Object.entries(
    createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test").server.proxy,
  );
  const id = "a0000000-0000-4000-8000-000000000001";
  for (const [resource, action] of [
    ["receiving", "amend"],
    ["receiving", "void"],
    ["receiving", "revisions"],
    ["lots", "receiving-basis"],
  ]) {
    const path = `/api/us/traceability/${resource}/${id}/${action}`;
    const read = action === "revisions" || action === "receiving-basis";
    const allowed = [
      "",
      ...(read ? ["?limit=1", "?offset=100000", "?limit=100&offset=0", "?offset=2&limit=1"] : []),
    ];
    for (const suffix of allowed) {
      const match = routes.find(([pattern]) => new RegExp(pattern).test(path + suffix));
      assert.ok(match, path + suffix);
      assert.equal(match[1].rewrite(path + suffix), (path + suffix).replace("/api/us", ""));
      assert.equal(match[1].changeOrigin, true);
    }
    for (const suffix of [
      "/",
      "/extra",
      "?",
      "?tenantId=x",
      "?limit=01",
      "?limit=101",
      "?offset=100001",
      "?offset=-1",
      "?limit=1&limit=2",
      "?offset=0&offset=1",
      "?limit=1&offset=0&limit=2",
      ...(read ? [] : ["?limit=1"]),
    ])
      assert.equal(
        routes.some(([pattern]) => new RegExp(pattern).test(path + suffix)),
        false,
        path + suffix,
      );
    assert.equal(
      routes.some(([pattern]) => new RegExp(pattern).test(path.replace(id, "not-a-uuid"))),
      false,
    );
  }
});

test("US Events, Transformation and Cases proxy admits exact bounded routes only", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const routes = Object.entries(
    createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test").server.proxy,
  );
  const id = "a0000000-0000-4000-8000-000000000001";
  const matches = (path) => routes.find(([pattern]) => new RegExp(pattern).test(path));
  for (const path of [
    "/api/us/traceability/events?type=transformation&limit=50&offset=0",
    "/api/us/traceability/events?type=shipping&limit=50&offset=0",
    `/api/us/traceability/transformation/${id}/revisions?offset=2&limit=1`,
    `/api/us/traceability/transformation/${id}/readiness?expectedDraftVersion=1`,
    `/api/us/traceability/transformation/${id}/finalize`,
    "/api/us/traceability/transformation/genealogy/query",
    `/api/us/traceability/lots/${id}/cases?limit=100&history=true`,
    `/api/us/traceability/lots/${id}/cases/${id}/unlink`,
  ]) {
    const match = matches(path);
    assert.ok(match, path);
    assert.equal(match[1].rewrite(path), path.replace(/^\/api\/us/, ""));
  }
  for (const path of [
    "/api/boxes",
    "/api/us/boxes",
    "/api/us/traceability/events?type=receiving&type=transformation",
    "/api/us/traceability/events?limit=101",
    "/api/us/traceability/events?tenantId=x",
    `/api/us/traceability/transformation/${id}/revisions?limit=101`,
    `/api/us/traceability/transformation/${id}/revisions?limit=1&limit=2`,
    `/api/us/traceability/transformation/${id}/extra`,
    `/api/us/traceability/transformation/not-a-uuid`,
    `/api/us/traceability/transformation/${id}/readiness?expectedDraftVersion=01`,
    `/api/us/traceability/lots/${id}/cases?limit=101`,
    `/api/us/traceability/lots/${id}/cases?limit=1&limit=2`,
    `/api/us/traceability/lots/not-a-uuid/cases`,
    `/api/us/traceability/lots/${id}/cases/${id}/unlink/extra`,
    `/api/us/traceability/lots/${id}/cases?tenantId=x`,
  ])
    assert.equal(matches(path), undefined, path);
});

test("US Shipping proxy admits only exact method and bounded path/query pairs", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const id = "a0000000-0000-4000-8000-000000000001";
  const routes = Object.entries(config.server.proxy);
  const matches = (path) => routes.some(([pattern]) => new RegExp(pattern).test(path));
  for (const path of [
    "/api/us/traceability/shipments",
    `/api/us/traceability/shipments/${id}`,
    `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=1`,
    `/api/us/traceability/shipments/${id}/revisions?limit=1&offset=0`,
    `/api/us/traceability/shipments/${id}/finalize`,
    `/api/us/traceability/shipments/${id}/amend`,
    `/api/us/traceability/shipments/${id}/void`,
    `/api/us/traceability/lots/${id}/shipping-balance`,
    `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${id}&expectedDraftVersion=2`,
  ])
    assert.equal(matches(path), true, path);
  for (const path of [
    "/api/us/traceability/shipments?tenantId=x",
    `/api/us/traceability/shipments/${id}?tenantId=x`,
    `/api/us/traceability/shipments/${id}/revisions?limit=1&limit=2`,
    `/api/us/traceability/shipments/${id}/revisions?limit=101&offset=0`,
    `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=01`,
    `/api/us/traceability/shipments/${id}/finalize?x=1`,
    `/api/us/traceability/shipments/${id}/unknown`,
    `/api/us/traceability/shipments/${id}/void/extra`,
    "/api/us/traceability/shipments/not-a-uuid",
    "/api/us/traceability/shipments/../profile",
    "/api/us/traceability/shipments/%2e%2e/profile",
    `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${id}`,
    `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${id}&expectedDraftVersion=02`,
    `/api/us/traceability/lots/${id}/shipping-balance?excludedEventId=${id}`,
  ])
    assert.equal(matches(path), false, path);
  const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let middleware;
    guard[hook]({
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    });
    const check = (method, url, accepted) => {
      let status;
      let next = false;
      middleware(
        { method, url },
        {
          writeHead: (value) => {
            status = value;
          },
          end() {},
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, accepted, `${method} ${url}`);
      assert.equal(status, accepted ? undefined : 404);
    };
    for (const [method, path] of [
      ["POST", "/api/us/traceability/shipments"],
      ["GET", `/api/us/traceability/shipments/${id}`],
      ["PUT", `/api/us/traceability/shipments/${id}`],
      ["GET", `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=1`],
      ["GET", `/api/us/traceability/shipments/${id}/revisions?limit=1&offset=0`],
      ["POST", `/api/us/traceability/shipments/${id}/finalize`],
      ["POST", `/api/us/traceability/shipments/${id}/amend`],
      ["POST", `/api/us/traceability/shipments/${id}/void`],
      ["GET", `/api/us/traceability/lots/${id}/shipping-balance`],
      [
        "GET",
        `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${id}&expectedDraftVersion=2`,
      ],
    ])
      check(method, path, true);
    for (const [method, path] of [
      ["GET", "/api/us/traceability/shipments"],
      ["DELETE", "/api/us/traceability/shipments"],
      ["POST", `/api/us/traceability/shipments/${id}`],
      ["GET", `/api/us/traceability/shipments/${id}/finalize`],
      ["POST", `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=1`],
      ["GET", `/api/us/traceability/shipments/${id}/readiness?expectedDraftVersion=2147483648`],
      ["PATCH", `/api/us/traceability/shipments/${id}`],
      ["POST", `/api/us/traceability/lots/${id}/shipping-balance`],
      [
        "GET",
        `/api/us/traceability/lots/${id}/shipping-balance?contextDraftId=${id}&expectedDraftVersion=2&tenantId=x`,
      ],
    ])
      check(method, path, false);
  }
});
test("US trace proxy admits exact bounded GET routes and rejects writes and untrusted queries", async () => {
  const { createUsAdminConfig } = await import("../../../apps/admin/vite.us.config.ts");
  const config = createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test");
  const id = "a0000000-0000-4000-8000-000000000001";
  const path = `/api/us/traceability/lots/${id}/trace`;
  const accepted = [
    path,
    `${path}?direction=both&maxDepth=20&maxNodes=500`,
    `${path}?maxDepth=0`,
    `${path}/history`,
    `${path}/history?limit=100&cursor=abc_-`,
  ];
  const rejected = [
    `${path}?tenantId=x`,
    `${path}?maxDepth=1&maxDepth=2`,
    `${path}?maxDepth=21`,
    `${path}?maxNodes=501`,
    `${path}?maxNodes=0`,
    `${path}/history?limit=101`,
    `${path}/history?limit=1&limit=2`,
    `${path}/history?cursor=a&cursor=b`,
    `${path}/history?tenantId=x`,
    `${path}/extra`,
    path.replace(id, "not-a-uuid"),
  ];
  const entries = Object.entries(config.server.proxy);
  for (const url of accepted) {
    const route = entries.find(([pattern]) => new RegExp(pattern).test(url));
    assert.ok(route, url);
    assert.equal(route[1].target, "http://localhost:3100");
    assert.equal(route[1].rewrite(url), url.replace(/^\/api\/us/, ""));
  }
  for (const url of rejected)
    assert.equal(
      entries.some(([pattern]) => new RegExp(pattern).test(url)),
      false,
      url,
    );
  const guard = config.plugins.find((plugin) => plugin.name === "us-api-allowlist");
  for (const hook of ["configureServer", "configurePreviewServer"]) {
    let middleware;
    guard[hook]({
      middlewares: {
        use: (handler) => {
          middleware = handler;
        },
      },
    });
    for (const [method, url, allowed] of [
      ...accepted.map((url) => ["GET", url, true]),
      ...rejected.map((url) => ["GET", url, false]),
      ...["POST", "PUT", "PATCH", "DELETE", "HEAD"].flatMap((method) =>
        accepted.map((url) => [method, url, false]),
      ),
    ]) {
      let next = false,
        status;
      middleware(
        { method, url },
        {
          writeHead: (value) => {
            status = value;
          },
          end() {},
        },
        () => {
          next = true;
        },
      );
      assert.equal(next, allowed, `${method} ${url}`);
      assert.equal(status, allowed ? undefined : 404);
    }
  }
});
