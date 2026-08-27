import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedApplicationCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https://storage.yandexcloud.net; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";
const smartCaptchaOrigin = "https://smartcaptcha.cloud.yandex.ru";
const yandexWebmasterVerificationScript =
  "https://cdn.jsdelivr.net/gh/yandex/webmaster-gtm-template@467fdc0c3ab3124a40ddf229fc8cd20392c71938/webmaster-verification.js";
const expectedLandingCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob: https://*.google-analytics.com https://www.googletagmanager.com https://mc.yandex.ru; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' https://smartcaptcha.cloud.yandex.ru https://cdn.jsdelivr.net/gh/yandex/webmaster-gtm-template@467fdc0c3ab3124a40ddf229fc8cd20392c71938/webmaster-verification.js https://www.googletagmanager.com https://mc.yandex.ru https://yastatic.net; frame-src 'self' https://smartcaptcha.cloud.yandex.ru https://mc.yandex.ru; connect-src 'self' https://smartcaptcha.cloud.yandex.ru https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://mc.yandex.ru wss://mc.yandex.ru; worker-src 'self' blob:; manifest-src 'self'";
const expectedVbtechCsp =
  "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://smartcaptcha.cloud.yandex.ru; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline' https://smartcaptcha.cloud.yandex.ru; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests";
const publicLandingBuildVariables = Object.freeze([
  "PUBLIC_DEMO_SUBMISSION_ENABLED",
  "PUBLIC_SMARTCAPTCHA_CLIENT_KEY",
  "PUBLIC_PHONE",
]);
const pinnedVeraPdfImage =
  "docker.io/verapdf/cli@sha256:d5ee329657cf9bc4b2400392dd54c7d0a0ce9980ff6fa2da5590eebeec007cdb";

const standardProxyTimeouts = Object.freeze({
  response_header_timeout: "30s",
  read_timeout: "60s",
  write_timeout: "60s",
});
const commerceMlProxyTimeouts = Object.freeze({
  response_header_timeout: "5m",
  read_timeout: "5m",
  write_timeout: "5m",
});
const adminHost = "admin.example.test";
const saasAdminHost = "saas-admin.example.test";
const kioskHost = "kiosk.example.test";
const landingHost = "markiro.example.test";
const vbtechHost = "v-b.tech";
const vbtechWwwHost = "www.v-b.tech";
const kioskReservedPatterns = Object.freeze([
  "/api",
  "/api/auth/*",
  "/api/*",
  "/1c_exchange",
  "/station",
  "/station/*",
  "/kiosk",
  "/kiosk/*",
  "/health*",
  "/openapi.json",
  "/docs*",
]);
const kioskForbiddenPaths = Object.freeze([
  "/api",
  "/api/auth/session",
  "/api/admin/tenants",
  "/api/demo-requests",
  "/1c_exchange",
  "/station",
  "/station/bootstrap",
  "/kiosk",
  "/kiosk/bootstrap",
  "/health",
  "/health/ready",
  "/healthful",
  "/openapi.json",
  "/docs",
  "/docs/swagger-ui.css",
  "/docs-old",
]);

function caddyPathMatches(pattern, path) {
  const normalizedPattern = pattern.toLowerCase();
  const normalizedPath = path.toLowerCase();
  return normalizedPattern.endsWith("*")
    ? normalizedPath.startsWith(normalizedPattern.slice(0, -1))
    : normalizedPath === normalizedPattern;
}

function caddyHeaderMatches(pattern, value) {
  return new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`).test(value);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}

function stationDevicePathMatches(caddy, path) {
  const devicePatterns =
    caddy
      .match(/^\s*@device path (.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const rootPatterns =
    caddy
      .match(/^\s*@stationRoot path (.+)$/m)?.[1]
      ?.trim()
      .split(/\s+/) ?? [];
  const shiftPattern = caddy.match(/^\s*@stationShift path_regexp stationShift (.+)$/m)?.[1];
  return (
    [...devicePatterns, ...rootPatterns].some((pattern) => caddyPathMatches(pattern, path)) ||
    (shiftPattern !== undefined && new RegExp(shiftPattern).test(path))
  );
}

function nestedObjects(value) {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nestedObjects)];
}

async function adaptCaddy(source, run = execFileSync) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-caddy-contract-"));
  const caddyfile = join(directory, "Caddyfile");
  await writeFile(caddyfile, source);
  try {
    try {
      return JSON.parse(
        run(
          "docker",
          [
            "run",
            "--rm",
            "-v",
            `${caddyfile}:/etc/caddy/Caddyfile:ro`,
            "-e",
            `MARKIRO_DOMAIN=${adminHost}`,
            "-e",
            `MARKIRO_SAAS_ADMIN_DOMAIN=${saasAdminHost}`,
            "-e",
            `MARKIRO_KIOSK_DOMAIN=${kioskHost}`,
            "-e",
            `MARKIRO_LANDING_DOMAIN=${landingHost}`,
            "-e",
            "ACME_EMAIL=ops@example.test",
            "-e",
            "MARKIRO_RELEASE_SHA=contract-sha",
            "caddy:2.11.4-alpine",
            "caddy",
            "adapt",
            "--config",
            "/etc/caddy/Caddyfile",
          ],
          { encoding: "utf8" },
        ),
      );
    } catch (error) {
      const stdout =
        typeof error === "object" && error !== null && typeof error.stdout === "string"
          ? error.stdout
          : "";
      if (stdout.length > 0) {
        try {
          return JSON.parse(stdout);
        } catch {
          // Preserve the command failure when stdout is absent, partial or not adapter JSON.
        }
      }
      throw error;
    }
  } finally {
    await rm(directory, { recursive: true });
  }
}

function hostRoutes(adapted, host) {
  const servers = Object.values(adapted.apps?.http?.servers ?? {});
  return servers
    .flatMap((server) => server.routes ?? [])
    .filter((route) => route.match?.some((matcher) => matcher.host?.includes(host)));
}

function applicationRoutes(adapted) {
  return Object.values(adapted.apps?.http?.servers ?? {})
    .flatMap((server) => server.routes ?? [])
    .filter((route) =>
      nestedObjects(route.handle).some(
        (candidate) => candidate.handler === "vars" && typeof candidate.root === "string",
      ),
    );
}

function applicationRoute(adapted, host) {
  const routes = hostRoutes(adapted, host).filter((route) =>
    nestedObjects(route.handle).some(
      (candidate) => candidate.handler === "vars" && typeof candidate.root === "string",
    ),
  );
  assert.equal(routes.length, 1, `${host} must have exactly one application route`);
  return routes[0];
}

function proxyRoutes(route) {
  return nestedObjects(route)
    .filter((candidate) => Array.isArray(candidate.match))
    .map((candidate) => ({
      paths: candidate.match.flatMap(
        (matcher) => matcher.path ?? (matcher.path_regexp ? [matcher.path_regexp.pattern] : []),
      ),
      methods: candidate.match.flatMap((matcher) => matcher.method ?? []),
      proxies: nestedObjects(candidate.handle).filter(
        (handler) => handler.handler === "reverse_proxy",
      ),
      rewrites: nestedObjects(candidate.handle).filter((handler) => handler.handler === "rewrite"),
    }))
    .filter(({ paths, proxies }) => paths.length > 0 && proxies.length > 0);
}

function kioskOrderedRouteTable(route) {
  const tables = nestedObjects(route).filter(
    (candidate) =>
      Array.isArray(candidate.routes) &&
      candidate.routes.some((entry) =>
        entry.match?.some((matcher) => matcher.path?.includes("/api/kiosk/*")),
      ),
  );
  assert.equal(tables.length, 1, "kiosk must have exactly one ordered application route table");
  return tables[0].routes;
}

function adaptedRouteMatches(route, { method, path, headers = {} }) {
  if (!Array.isArray(route.match)) return true;
  return route.match.some(
    (matcher) =>
      (!Array.isArray(matcher.method) || matcher.method.includes(method)) &&
      (!Array.isArray(matcher.path) ||
        matcher.path.some((pattern) => caddyPathMatches(pattern, path))) &&
      (matcher.path_regexp === undefined || new RegExp(matcher.path_regexp.pattern).test(path)) &&
      (matcher.header === undefined ||
        Object.entries(matcher.header).every(([name, patterns]) => {
          const value = headers[name.toLowerCase()];
          return (
            value !== undefined && patterns.some((pattern) => caddyHeaderMatches(pattern, value))
          );
        })),
  );
}

function selectedAdaptedRoute(routeTable, request) {
  const route = routeTable.find((candidate) => adaptedRouteMatches(candidate, request));
  assert.ok(route, `${request.method} ${request.path} must select a terminal kiosk route`);
  return route;
}

function assertOnlyPlain404(route, request) {
  const objects = nestedObjects(route);
  assert.deepEqual(
    objects.filter((candidate) => candidate.handler === "static_response"),
    [{ handler: "static_response", status_code: 404 }],
    `${request.method} ${request.path} must terminate at a plain 404`,
  );
  for (const forbiddenHandler of ["vars", "rewrite", "file_server", "reverse_proxy"]) {
    assert.ok(
      objects.every((candidate) => candidate.handler !== forbiddenHandler),
      `${request.method} ${request.path} must not reach ${forbiddenHandler}`,
    );
  }
  assert.ok(
    objects.every((candidate) => candidate.file === undefined),
    `${request.method} ${request.path} must not reach try_files`,
  );
}

function applicationOrderedRouteTable(route) {
  const routeTable = nestedObjects(route).find(
    (candidate) =>
      Array.isArray(candidate.routes) &&
      candidate.routes.some((entry) =>
        nestedObjects(entry).some((value) => value.handler === "file_server"),
      ) &&
      candidate.routes
        .at(-1)
        ?.handle?.some(
          (handler) => handler.handler === "static_response" && handler.status_code === 404,
        ),
  )?.routes;
  assert.ok(routeTable, "application must have an ordered route table");
  return routeTable;
}

function assertKioskRoutingBoundary(route) {
  const routeTable = kioskOrderedRouteTable(route);
  const reservedRoutes = routeTable.filter((candidate) =>
    nestedObjects(candidate).some(
      (value) => value.handler === "static_response" && value.status_code === 404,
    ),
  );
  assert.equal(reservedRoutes.length, 2, "kiosk must have reserved and final 404 routes");
  assert.deepEqual(
    reservedRoutes[0].match?.flatMap((matcher) => matcher.path ?? []),
    kioskReservedPatterns,
    "kiosk must explicitly reserve every non-PWA namespace",
  );

  for (const path of kioskForbiddenPaths) {
    for (const method of ["GET", "HEAD"]) {
      const request = { method, path };
      assertOnlyPlain404(selectedAdaptedRoute(routeTable, request), request);
    }
  }

  for (const method of ["GET", "HEAD", "POST"]) {
    const request = { method, path: "/api/kiosk/bootstrap" };
    const selected = selectedAdaptedRoute(routeTable, request);
    assert.deepEqual(
      nestedObjects(selected).filter((candidate) => candidate.handler === "rewrite"),
      [{ handler: "rewrite", strip_path_prefix: "/api" }],
      `${method} /api/kiosk/* must strip exactly /api before proxying`,
    );
    assert.equal(
      nestedObjects(selected).filter((candidate) => candidate.handler === "reverse_proxy").length,
      1,
      `${method} /api/kiosk/* must reach exactly one proxy`,
    );
    assert.ok(
      nestedObjects(selected).every(
        (candidate) =>
          candidate.handler !== "file_server" && candidate.handler !== "static_response",
      ),
      `${method} /api/kiosk/* must win before static and 404 handlers`,
    );
  }

  for (const method of ["GET", "HEAD"]) {
    const request = { method, path: "/pickup/complete" };
    const selected = selectedAdaptedRoute(routeTable, request);
    assert.ok(
      nestedObjects(selected).some((candidate) => candidate.handler === "file_server"),
      `${method} client-side kiosk deep links must retain the SPA fallback`,
    );
    assert.ok(
      nestedObjects(selected).some((candidate) =>
        candidate.file?.try_files?.includes("/index.html"),
      ),
      `${method} client-side kiosk deep links must try index.html`,
    );
    assert.ok(
      nestedObjects(selected).every(
        (candidate) =>
          candidate.handler !== "reverse_proxy" && candidate.handler !== "static_response",
      ),
      `${method} client-side kiosk deep links must remain static-only`,
    );
  }
}

function assertPlainFallback(route, host) {
  const routeTable = applicationOrderedRouteTable(route);
  const fallback = routeTable
    .at(-1)
    .handle.filter((candidate) => candidate.handler === "static_response");
  assert.deepEqual(fallback, [{ handler: "static_response", status_code: 404 }]);
}

function normalizeAdminRoute(route) {
  const normalized = structuredClone(route);
  for (const proxy of nestedObjects(normalized).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  )) {
    const requestHeaders = proxy.headers?.request;
    const setHeaders = requestHeaders?.set;
    if (setHeaders) delete setHeaders["X-Forwarded-Proto"];
    if (setHeaders && Object.keys(setHeaders).length === 0) delete requestHeaders.set;
    if (requestHeaders && Object.keys(requestHeaders).length === 0) delete proxy.headers.request;
    if (proxy.headers && Object.keys(proxy.headers).length === 0) delete proxy.headers;
  }
  return normalized;
}

function assertAuthorityContract(adapted, { alb }) {
  const approvedHosts = [adminHost, saasAdminHost, kioskHost, landingHost];
  const applications = applicationRoutes(adapted);
  assert.equal(applications.length, approvedHosts.length);
  for (const route of applications) {
    assert.equal(route.match?.length, 1, "every application route must have one Host matcher");
    assert.deepEqual(
      Object.keys(route.match[0]),
      ["host"],
      "application routes must be selected only by Host",
    );
    assert.equal(route.match[0].host?.length, 1, "every application route must name one Host");
    assert.ok(
      approvedHosts.includes(route.match[0].host[0]),
      `unapproved application Host ${route.match[0].host[0]}`,
    );
  }
  const hosts = [
    ...new Set(
      nestedObjects(adapted)
        .filter((candidate) => Array.isArray(candidate.host))
        .flatMap((candidate) => candidate.host),
    ),
  ].sort();
  assert.deepEqual(
    hosts,
    [adminHost, saasAdminHost, kioskHost, landingHost, vbtechHost, vbtechWwwHost].sort(),
  );

  const admin = applicationRoute(adapted, adminHost);
  const saasAdmin = applicationRoute(adapted, saasAdminHost);
  const kiosk = applicationRoute(adapted, kioskHost);
  const landing = applicationRoute(adapted, landingHost);
  for (const [host, route, expectedRoot] of [
    [adminHost, admin, "/srv/admin"],
    [saasAdminHost, saasAdmin, "/srv/saas-admin"],
    [kioskHost, kiosk, "/srv/kiosk"],
    [landingHost, landing, "/srv/landing"],
  ]) {
    const roots = nestedObjects(route)
      .filter((candidate) => candidate.handler === "vars" && typeof candidate.root === "string")
      .map((candidate) => candidate.root);
    assert.deepEqual(roots, [expectedRoot], `${host} must use only ${expectedRoot}`);

    const headerHandlers = nestedObjects(route).filter(
      (candidate) => candidate.handler === "headers",
    );
    const headerSets = headerHandlers.map((candidate) => candidate.response?.set ?? {});
    assert.ok(
      headerHandlers.some((handler) => {
        const headers = handler.response?.set ?? {};
        return (
          handler.response?.deferred === true &&
          headers["X-Markiro-Release-Sha"]?.[0] === "contract-sha" &&
          headers["Strict-Transport-Security"]?.[0] === "max-age=63072000; includeSubDomains" &&
          headers["X-Content-Type-Options"]?.[0] === "nosniff" &&
          headers["X-Frame-Options"]?.[0] === "SAMEORIGIN" &&
          headers["Referrer-Policy"]?.[0] === "strict-origin-when-cross-origin"
        );
      }),
      `${host} must defer the common security and release headers through error responses`,
    );
    const contentSecurityPolicies = headerSets.flatMap(
      (headers) => headers["Content-Security-Policy"] ?? [],
    );
    assert.deepEqual(
      contentSecurityPolicies,
      [host === landingHost ? expectedLandingCsp : expectedApplicationCsp],
      `${host} must emit exactly one authority-specific CSP`,
    );
    if (host === landingHost) {
      assert.equal(
        contentSecurityPolicies[0].split(smartCaptchaOrigin).length - 1,
        3,
        "landing CSP must add SmartCaptcha only to script, frame and connect sources",
      );
      assert.match(
        contentSecurityPolicies[0],
        /script-src[^;]*https:\/\/www\.googletagmanager\.com/,
      );
      assert.match(
        contentSecurityPolicies[0],
        /connect-src[^;]*https:\/\/\*\.google-analytics\.com/,
      );
      assert.match(contentSecurityPolicies[0], /script-src[^;]*https:\/\/mc\.yandex\.ru/);
      assert.match(contentSecurityPolicies[0], /connect-src[^;]*https:\/\/mc\.yandex\.ru/);
      assert.match(
        contentSecurityPolicies[0],
        new RegExp(`script-src[^;]*${yandexWebmasterVerificationScript.replaceAll(".", "\\.")}`),
      );
      assert.doesNotMatch(
        contentSecurityPolicies[0],
        /script-src[^;]*(?:^|\s)https:\/\/cdn\.jsdelivr\.net(?:\s|;)/,
      );
      assert.match(contentSecurityPolicies[0], /frame-src[^;]*https:\/\/mc\.yandex\.ru/);
      assert.match(contentSecurityPolicies[0], /connect-src[^;]*wss:\/\/mc\.yandex\.ru/);
    } else {
      assert.doesNotMatch(contentSecurityPolicies[0], /smartcaptcha/i);
    }
    assert.ok(
      headerSets.some(
        (headers) => headers["Cache-Control"]?.[0] === "public, max-age=31536000, immutable",
      ),
      `${host} must emit immutable asset caching`,
    );
    assert.ok(
      headerSets.some((headers) => headers["Cache-Control"]?.[0] === "no-cache"),
      `${host} must disable SPA document caching`,
    );
    const methods = nestedObjects(route)
      .filter((candidate) => Array.isArray(candidate.method))
      .map((candidate) => candidate.method);
    assert.deepEqual(
      methods,
      host === adminHost
        ? [["OPTIONS"], ["OPTIONS"], ["GET", "HEAD"]]
        : host === kioskHost || host === saasAdminHost
          ? [["GET", "HEAD"]]
          : [
              ["POST"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
              ["GET", "HEAD"],
            ],
      `${host} must reserve mutations for API handlers instead of the SPA`,
    );
    assertPlainFallback(route, host);
  }

  const expectedAdminPaths = [
    ["/api/auth/*"],
    ["/api/*"],
    ["/1c_exchange"],
    ["/station/*", "/kiosk/*", "/health", "/health/*", "/openapi.json", "/docs", "/docs/*"],
    ["/shifts", "/shifts/box-label-templates", "/products", "/products/gtin-check"],
    ["/shifts", "/shifts/box-label-templates", "/products", "/products/gtin-check"],
    ["^/shifts/[^/]+/(open|bundle|reference-bundle)$"],
    ["^/shifts/[^/]+/(open|bundle|reference-bundle)$"],
  ];
  const adminProxies = proxyRoutes(admin);
  const adminReverseProxies = nestedObjects(admin).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  );
  assert.equal(adminReverseProxies.length, 8);
  assert.deepEqual(
    adminProxies.map(({ paths }) => paths),
    expectedAdminPaths,
  );
  assert.ok(adminProxies.every(({ proxies }) => proxies.length === 1));
  const adminRoutes = applicationOrderedRouteTable(admin);
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    const request = { method, path: "/api/demo-requests" };
    const selected = selectedAdaptedRoute(adminRoutes, request);
    assert.deepEqual(
      selected.match,
      [{ path: ["/api/demo-requests"] }],
      "admin demo-request denial must match the exact path for every method",
    );
    assertOnlyPlain404(selected, request);
  }
  for (const path of ["/api/demo-request", "/api/demo-requests/", "/api/demo-requests/extra"]) {
    const request = { method: "POST", path };
    const selected = selectedAdaptedRoute(adminRoutes, request);
    assert.equal(
      nestedObjects(selected).filter((candidate) => candidate.handler === "reverse_proxy").length,
      1,
      `adjacent admin path ${path} must retain the generic API proxy`,
    );
    assert.deepEqual(
      nestedObjects(selected).filter((candidate) => candidate.handler === "rewrite"),
      [{ handler: "rewrite", strip_path_prefix: "/api" }],
      `adjacent admin path ${path} must retain the generic API rewrite`,
    );
  }

  const saasAdminProxies = proxyRoutes(saasAdmin);
  const saasAdminReverseProxies = nestedObjects(saasAdmin).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  );
  assert.equal(saasAdminReverseProxies.length, 2);
  assert.deepEqual(
    saasAdminProxies.map(({ paths }) => paths),
    [["/api/platform-auth/*"], ["/api/platform/*"]],
  );
  assert.deepEqual(saasAdminProxies[0].rewrites, []);
  assert.deepEqual(saasAdminProxies[1].rewrites, [
    { handler: "rewrite", strip_path_prefix: "/api" },
  ]);
  const saasAdminRoutes = applicationOrderedRouteTable(saasAdmin);
  for (const path of [
    "/api",
    "/api/auth/get-session",
    "/api/kiosk/bootstrap",
    "/station/bootstrap",
    "/health/ready",
    "/docs",
  ]) {
    const request = { method: "GET", path };
    assertOnlyPlain404(selectedAdaptedRoute(saasAdminRoutes, request), request);
  }

  const kioskProxies = proxyRoutes(kiosk);
  const kioskReverseProxies = nestedObjects(kiosk).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  );
  assert.equal(kioskReverseProxies.length, 1, "kiosk must have exactly one reverse proxy");
  assert.deepEqual(
    kioskProxies.map(({ paths }) => paths),
    [["/api/kiosk/*"]],
  );
  assert.deepEqual(kioskProxies[0].rewrites, [{ handler: "rewrite", strip_path_prefix: "/api" }]);
  assertKioskRoutingBoundary(kiosk);
  const landingProxies = proxyRoutes(landing);
  assert.equal(landingProxies.length, 1);
  assert.deepEqual(landingProxies[0].paths, ["/api/demo-requests"]);
  assert.deepEqual(landingProxies[0].methods, ["POST"]);
  assert.deepEqual(landingProxies[0].rewrites, [{ handler: "rewrite", strip_path_prefix: "/api" }]);
  const landingRoutes = applicationOrderedRouteTable(landing);
  const landingDemoRequest = { method: "POST", path: "/api/demo-requests" };
  const selectedLandingDemoRequest = selectedAdaptedRoute(landingRoutes, landingDemoRequest);
  assert.deepEqual(
    nestedObjects(selectedLandingDemoRequest).filter(
      (candidate) => candidate.handler === "request_body",
    ),
    [{ handler: "request_body", max_size: 4000 }],
  );
  assert.equal(
    nestedObjects(selectedLandingDemoRequest).filter(
      (candidate) => candidate.handler === "reverse_proxy",
    ).length,
    1,
  );
  assert.ok(
    nestedObjects(selectedLandingDemoRequest).every(
      (candidate) => candidate.handler !== "file_server" && candidate.handler !== "static_response",
    ),
  );
  for (const method of ["GET", "HEAD", "PUT"]) {
    const request = { method, path: "/api/demo-requests" };
    assertOnlyPlain404(selectedAdaptedRoute(landingRoutes, request), request);
  }
  for (const path of [
    "/api",
    "/api/demo-request",
    "/api/demo-requests/",
    "/api/demo-requests/extra",
    "/api/other",
    "/api/auth/session",
    "/1c_exchange",
    "/station/bootstrap",
    "/kiosk/bootstrap",
    "/health",
    "/openapi.json",
    "/docs",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "PUT"]) {
      const request = { method, path };
      assertOnlyPlain404(selectedAdaptedRoute(landingRoutes, request), request);
    }
  }
  for (const path of [
    "/",
    "/faq/",
    "/d/MKR-PD-01/2026.08/01/15.08.2026",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
  ]) {
    const request = { method: "GET", path };
    const selected = selectedAdaptedRoute(landingRoutes, request);
    assert.ok(
      nestedObjects(selected).some((candidate) => candidate.handler === "file_server"),
      `landing GET ${path} must reach static files`,
    );
    assert.ok(
      nestedObjects(selected).every((candidate) => candidate.handler !== "reverse_proxy"),
      `landing GET ${path} must remain static-only`,
    );
    assert.ok(
      nestedObjects(selected).every(
        (candidate) => candidate.handler !== "static_response" || candidate.status_code === 404,
      ),
      `landing GET ${path} must not redirect to a slash-appended route`,
    );
  }
  for (const method of ["GET", "HEAD"]) {
    const request = { method, path: "/definitely-missing/" };
    const selected = landingRoutes.find(
      (candidate) =>
        adaptedRouteMatches(candidate, request) &&
        nestedObjects(candidate).some(
          (handler) => handler.handler === "rewrite" && handler.uri === "/404.html",
        ),
    );
    assert.ok(selected, "landing route table must contain a branded missing-document fallback");
    const objects = nestedObjects(selected);
    assert.deepEqual(
      objects.filter((candidate) => candidate.handler === "rewrite"),
      [{ handler: "rewrite", uri: "/404.html" }],
      "landing unknown reads must rewrite only to the bounded branded 404 artifact",
    );
    assert.deepEqual(
      objects.filter((candidate) => candidate.handler === "file_server"),
      [{ handler: "file_server", hide: ["/etc/caddy/Caddyfile"], status_code: 404 }],
      "landing branded 404 must keep the actual HTTP 404 status",
    );
    assert.ok(
      objects.every((candidate) => candidate.handler !== "reverse_proxy"),
      "landing branded 404 must remain static-only",
    );
  }
  const landingReverseProxies = nestedObjects(landing).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  );
  for (const proxy of [
    ...adminReverseProxies,
    ...saasAdminReverseProxies,
    ...kioskReverseProxies,
    ...landingReverseProxies,
  ]) {
    const forwardedProto = proxy.headers?.request?.set?.["X-Forwarded-Proto"];
    if (alb) assert.deepEqual(forwardedProto, ["https"]);
    else assert.equal(forwardedProto, undefined);
  }

  return {
    adminRoute: normalizeAdminRoute(admin),
    adminPaths: adminProxies.map(({ paths }) => paths),
    adminTransports: adminProxies.map(({ proxies }) => proxies[0].transport),
  };
}

function dockerfileInstructions(dockerfile) {
  for (const physicalLine of dockerfile.split(/\r?\n/)) {
    const parserDirective = physicalLine.match(/^\s*#\s*([a-z][a-z0-9_-]*)\s*=\s*(\S+)\s*$/i);
    if (!parserDirective) break;
    if (parserDirective[1].toLowerCase() === "escape" && parserDirective[2] !== "\\") {
      assert.fail(
        "non-default Dockerfile escape directives are unsupported by the runtime contract",
      );
    }
  }

  const instructions = [];
  let logicalLine = "";

  for (const physicalLine of dockerfile.split(/\r?\n/)) {
    const trimmed = physicalLine.trim();
    if (logicalLine === "" && (trimmed === "" || trimmed.startsWith("#"))) continue;

    const continued = /\\\s*$/.test(physicalLine);
    const part = physicalLine.replace(/\\\s*$/, "").trim();
    logicalLine = logicalLine === "" ? part : `${logicalLine} ${part}`;
    if (continued) continue;

    const match = logicalLine.match(/^([a-z]+)\s+(.+?)\s*$/i);
    assert.ok(match, `unsupported Dockerfile instruction: ${logicalLine}`);
    if (/(?:^|\s)<<-?(?:["'][^"']+["']|\S+)/.test(match[2])) {
      assert.fail("Dockerfile heredoc instructions are unsupported by the runtime contract");
    }
    instructions.push({ name: match[1].toUpperCase(), arguments: match[2] });
    logicalLine = "";
  }

  assert.equal(logicalLine, "", "Dockerfile must not end with an unterminated continuation");
  return instructions;
}

test("v-b authorities are exact, isolated, canonical and expose only the approved contact proxy", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");

  assert.match(caddy, /^http:\/\/v-b\.tech:8080 \{$/m);
  assert.match(caddy, /^http:\/\/www\.v-b\.tech:8080 \{$/m);
  assert.match(caddy, /^https:\/\/v-b\.tech:8443 \{$/m);
  assert.match(caddy, /^https:\/\/www\.v-b\.tech:8443 \{$/m);
  assert.match(caddy, /redir https:\/\/v-b\.tech\{uri\} permanent/);
  assert.match(caddy, /reverse_proxy vbtech-web:8080/);
  assert.match(caddy, /method POST[\s\S]*path \/api\/contact/);
  assert.match(caddy, /request_body \{[\s\S]*max_size 16KB/);
  assert.match(caddy, /rewrite \* \{env\.VBTECH_FUNCTION_PATH\}/);
  assert.match(caddy, /reverse_proxy https:\/\/functions\.yandexcloud\.net/);
  assert.match(caddy, /@vbtechReserved path \/api \/api\/\*/);
  assert.match(caddy, /Content-Security-Policy "([^"]+)"/);
  assert.ok(caddy.includes(expectedVbtechCsp));
  const apexBlock = caddy.match(/^https:\/\/v-b\.tech:8443 \{\n([\s\S]*?)^\}/m)?.[1] ?? "";
  assert.match(apexBlock, /import vbtech_headers/);
  assert.match(apexBlock, /import vbtech_routes/);
  assert.doesNotMatch(apexBlock, /admin_routes|kiosk_routes|landing_routes|common_headers/);
});

function dockerfileStageInstructions(dockerfile, stageName) {
  const instructions = dockerfileInstructions(dockerfile);
  const stageIndex = instructions.findIndex(
    (instruction) =>
      instruction.name === "FROM" &&
      new RegExp(`\\s+AS\\s+${stageName}$`, "i").test(instruction.arguments),
  );
  assert.notEqual(stageIndex, -1, `Dockerfile stage ${stageName} must exist`);

  const nextStageOffset = instructions
    .slice(stageIndex + 1)
    .findIndex((instruction) => instruction.name === "FROM");
  const end = nextStageOffset === -1 ? instructions.length : stageIndex + 1 + nextStageOffset;
  return instructions.slice(stageIndex + 1, end);
}

function assertEdgeImageContract(dockerfile, dockerignore) {
  const baseInstructions = dockerfileStageInstructions(dockerfile, "build-base");
  const applicationInstructions = dockerfileStageInstructions(dockerfile, "application-build");
  const landingInstructions = dockerfileStageInstructions(dockerfile, "landing-build");
  const base = baseInstructions
    .map((instruction) => `${instruction.name} ${instruction.arguments}`)
    .join("\n");
  assert.match(base, /RUN pnpm install --frozen-lockfile/);
  for (const input of [
    "apps/admin/package.json ./apps/admin/package.json",
    "apps/saas-admin/package.json ./apps/saas-admin/package.json",
    "apps/kiosk/package.json ./apps/kiosk/package.json",
    "apps/landing/package.json ./apps/landing/package.json",
    "packages/platform-contracts/package.json ./packages/platform-contracts/package.json",
    "packages/legal-documents/package.json ./packages/legal-documents/package.json",
    "apps/admin ./apps/admin",
    "apps/saas-admin ./apps/saas-admin",
    "apps/kiosk ./apps/kiosk",
    "apps/landing ./apps/landing",
    "packages/platform-contracts ./packages/platform-contracts",
    "packages/legal-documents ./packages/legal-documents",
  ]) {
    assert.match(base, new RegExp(`COPY ${escapeRegExp(input)}`));
  }
  assert.deepEqual(applicationInstructions, [
    {
      name: "RUN",
      arguments:
        "pnpm turbo build --filter @markiro/admin... --filter @markiro/saas-admin... --filter @markiro/kiosk...",
    },
  ]);
  assert.deepEqual(
    landingInstructions.filter((instruction) => instruction.name === "ARG"),
    publicLandingBuildVariables.map((name) => ({
      name: "ARG",
      arguments: `${name}=${name === "PUBLIC_DEMO_SUBMISSION_ENABLED" ? "false" : ""}`,
    })),
  );
  assert.deepEqual(
    landingInstructions.filter((instruction) => instruction.name === "ENV"),
    publicLandingBuildVariables.map((name) => ({
      name: "ENV",
      arguments: `${name}=\${${name}}`,
    })),
  );
  assert.deepEqual(
    landingInstructions.filter((instruction) => instruction.name === "RUN"),
    [
      { name: "RUN", arguments: "pnpm --filter @markiro/ui build" },
      { name: "RUN", arguments: "pnpm --filter @markiro/landing build" },
    ],
  );
  for (const instruction of [...baseInstructions, ...applicationInstructions]) {
    for (const name of publicLandingBuildVariables) {
      assert.doesNotMatch(`${instruction.name} ${instruction.arguments}`, new RegExp(name));
    }
  }
  assert.doesNotMatch(dockerfile, /SMARTCAPTCHA_SERVER_KEY|ysc2_/);

  const runtimeInstructions = dockerfileStageInstructions(dockerfile, "runtime");
  const runtime = runtimeInstructions
    .map((instruction) => `${instruction.name} ${instruction.arguments}`)
    .join("\n");
  assert.match(
    runtime,
    /COPY --from=application-build \/workspace\/apps\/admin\/dist \/srv\/admin/,
  );
  assert.match(
    runtime,
    /COPY --from=application-build \/workspace\/apps\/saas-admin\/dist \/srv\/saas-admin/,
  );
  assert.match(
    runtime,
    /COPY --from=application-build \/workspace\/apps\/kiosk\/dist \/srv\/kiosk/,
  );
  assert.match(
    runtime,
    /COPY --from=landing-build \/workspace\/apps\/landing\/dist \/srv\/landing/,
  );
  assert.match(runtime, /addgroup -S -g 10001 markiro/);
  assert.match(runtime, /setcap -r \/usr\/bin\/caddy/);
  assert.match(runtime, /USER 10001:10001/);
  assert.doesNotMatch(runtime, /node|pnpm/);
  assert.doesNotMatch(
    runtime,
    /soffice|libreoffice|verapdf|java|\.markiro-releases|generate-artifacts|\.docx/i,
  );
  const runtimeCopies = runtimeInstructions
    .filter((instruction) => instruction.name === "COPY")
    .map((instruction) => instruction.arguments);
  assert.deepEqual(runtimeCopies, [
    "deploy/production/Caddyfile /etc/caddy/Caddyfile",
    "deploy/production/edge-entrypoint.sh /usr/bin/edge-entrypoint",
    "--from=application-build /workspace/apps/admin/dist /srv/admin",
    "--from=application-build /workspace/apps/saas-admin/dist /srv/saas-admin",
    "--from=application-build /workspace/apps/kiosk/dist /srv/kiosk",
    "--from=landing-build /workspace/apps/landing/dist /srv/landing",
  ]);
  const buildCopies = runtimeCopies
    .filter((copy) => copy.startsWith("--from=application-build "))
    .map((copy) => copy.slice("--from=application-build ".length));
  assert.deepEqual(buildCopies, [
    "/workspace/apps/admin/dist /srv/admin",
    "/workspace/apps/saas-admin/dist /srv/saas-admin",
    "/workspace/apps/kiosk/dist /srv/kiosk",
  ]);
  assert.deepEqual(
    runtimeCopies.filter((copy) => copy.startsWith("--from=landing-build ")),
    ["--from=landing-build /workspace/apps/landing/dist /srv/landing"],
  );

  for (const buildInput of [
    "!apps/",
    "!apps/admin/",
    "!apps/admin/**",
    "!apps/saas-admin/",
    "!apps/saas-admin/**",
    "!apps/kiosk/",
    "!apps/kiosk/**",
    "!apps/landing/",
    "!apps/landing/**",
    "!packages/",
    "!packages/ui/",
    "!packages/ui/**",
    "!packages/platform-contracts/",
    "!packages/platform-contracts/**",
    "!packages/legal-documents/",
    "!packages/legal-documents/**",
    "!deploy/",
    "!deploy/production/",
    "!deploy/production/Caddyfile",
  ]) {
    assert.ok(dockerignore.includes(buildInput), `${buildInput} must be included`);
  }
  assert.match(dockerignore, /^\*\*\/node_modules$/m);
  assert.match(dockerignore, /^dist\/$/m);
  assert.match(dockerignore, /^\*\*\/dist\/$/m);
}

test("platform authority serves only the SaaS shell and platform API namespaces", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  assert.match(caddy, /^http:\/\/\{\$MARKIRO_SAAS_ADMIN_DOMAIN\}:8080 \{$/m);
  assert.match(caddy, /^https:\/\/\{\$MARKIRO_SAAS_ADMIN_DOMAIN\}:8443 \{$/m);
  const platformRoutes = caddy.match(/\(saas_admin_routes\) \{([\s\S]*?)^\}/m)?.[1] ?? "";
  assert.match(platformRoutes, /root \* \/srv\/saas-admin/);
  assert.match(platformRoutes, /@platformAuth path \/api\/platform-auth\/\*/);
  assert.match(platformRoutes, /@platformApi path \/api\/platform\/\*/);
  assert.match(platformRoutes, /handle @platformApi/);
  assert.match(platformRoutes, /uri strip_prefix \/api/);
  assert.match(platformRoutes, /@platformReserved path \/api \/api\/\*/);
  assert.doesNotMatch(platformRoutes, /admin_routes|kiosk_routes|landing_routes/);
});

test("edge build validates every tracked legal artifact before copying landing output", async () => {
  const [dockerfile, dockerignore, manifestSource] = await Promise.all([
    readFile("deploy/production/edge.Dockerfile", "utf8"),
    readFile(".dockerignore", "utf8"),
    readFile("apps/landing/public/legal/artifacts.json", "utf8"),
  ]);
  const artifacts = JSON.parse(manifestSource);
  assert.equal(artifacts.length, 16);
  assert.equal(new Set(artifacts.map(({ fileName }) => fileName)).size, artifacts.length);
  for (const artifact of artifacts) {
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    await readFile(`apps/landing/public/legal/files/${artifact.fileName}`);
  }
  assert.match(dockerfile, /COPY apps\/landing \.\/apps\/landing/);
  assert.match(
    dockerfile,
    /COPY deploy\/production\/legal-artifacts-attestation\.json \.\/deploy\/production\/legal-artifacts-attestation\.json/,
  );
  assert.match(
    dockerfile,
    /COPY deploy\/production\/cli-main\.mjs \.\/deploy\/production\/cli-main\.mjs/,
  );
  assert.match(dockerignore, /^!deploy\/production\/legal-artifacts-attestation\.json$/m);
  assert.match(dockerignore, /^!deploy\/production\/cli-main\.mjs$/m);
  assert.match(
    dockerfile,
    /node deploy\/production\/verify-legal-artifacts\.mjs apps\/landing\/public\/legal deploy\/production\/legal-artifacts-attestation\.json/,
  );
  assert.match(
    dockerfile,
    /COPY --from=landing-build \/workspace\/apps\/landing\/dist \/srv\/landing/,
  );
});

test("edge build obtains fresh PDF/A evidence from the pinned veraPDF image", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  assert.match(dockerfile, /^ARG LEGAL_PDFA_PLATFORM=linux\/amd64$/m);
  assert.match(
    dockerfile,
    new RegExp(
      `^FROM --platform=\\\${LEGAL_PDFA_PLATFORM} ${escapeRegExp(pinnedVeraPdfImage)} AS legal-pdfa-runtime$`,
      "m",
    ),
  );
  assert.match(
    dockerfile,
    /^FROM --platform=\$\{LEGAL_PDFA_PLATFORM\} node:24\.19\.0-alpine AS legal-artifact-verification$/m,
  );
  const verification = dockerfileStageInstructions(dockerfile, "legal-artifact-verification");
  assert.deepEqual(
    verification.filter((instruction) => instruction.name === "WORKDIR"),
    [{ name: "WORKDIR", arguments: "/workspace" }],
  );
  assert.deepEqual(
    verification.filter((instruction) => instruction.name === "ENV"),
    [
      { name: "ENV", arguments: "JAVA_HOME=/opt/java/openjdk" },
      { name: "ENV", arguments: "PATH=/opt/java/openjdk/bin:${PATH}" },
    ],
  );
  assert.deepEqual(
    verification.filter((instruction) => instruction.name === "COPY"),
    [
      {
        name: "COPY",
        arguments: "--from=legal-pdfa-runtime /opt/java/openjdk /opt/java/openjdk",
      },
      {
        name: "COPY",
        arguments: "--from=legal-pdfa-runtime /opt/verapdf /opt/verapdf",
      },
      {
        name: "COPY",
        arguments:
          "--from=legal-documents-build /workspace/packages/legal-documents/dist ./packages/legal-documents/dist",
      },
      {
        name: "COPY",
        arguments:
          "--from=legal-documents-build /workspace/apps/landing/public/legal ./apps/landing/public/legal",
      },
      {
        name: "COPY",
        arguments:
          "--from=legal-documents-build /workspace/deploy/production/cli-main.mjs ./deploy/production/cli-main.mjs",
      },
      {
        name: "COPY",
        arguments:
          "--from=legal-documents-build /workspace/deploy/production/verify-legal-artifacts.mjs ./deploy/production/verify-legal-artifacts.mjs",
      },
      {
        name: "COPY",
        arguments:
          "--from=legal-documents-build /workspace/deploy/production/legal-artifacts-attestation.json ./deploy/production/legal-artifacts-attestation.json",
      },
    ],
  );
  assert.deepEqual(
    verification.filter((instruction) => instruction.name === "RUN"),
    [
      {
        name: "RUN",
        arguments:
          "--network=none VERAPDF_BIN=/opt/verapdf/verapdf node deploy/production/verify-legal-artifacts.mjs apps/landing/public/legal deploy/production/legal-artifacts-attestation.json && touch /tmp/legal-artifacts.verified",
      },
    ],
  );

  const landing = dockerfileStageInstructions(dockerfile, "landing-build");
  assert.ok(
    landing.some(
      (instruction) =>
        instruction.name === "COPY" &&
        instruction.arguments ===
          "--from=legal-artifact-verification /tmp/legal-artifacts.verified /tmp/legal-artifacts.verified",
    ),
  );
});

function mutate(source, search, replacement) {
  const changed = source.replace(search, replacement);
  assert.notEqual(changed, source, `mutation must replace ${String(search)}`);
  return changed;
}

test("Caddy adapter keeps complete JSON after a container cleanup failure", async () => {
  const cleanupError = new Error("unexpected EOF");
  cleanupError.stdout = '{"apps":{"http":{"servers":{}}}}';

  const adapted = await adaptCaddy("", () => {
    throw cleanupError;
  });

  assert.deepEqual(adapted, { apps: { http: { servers: {} } } });
});

test("device proxy matcher retains exact infrastructure boundaries", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const patterns = caddy
    .match(/^\s*@device path (.+)$/m)?.[1]
    ?.trim()
    .split(/\s+/);

  assert.deepEqual(patterns, [
    "/station/*",
    "/kiosk/*",
    "/health",
    "/health/*",
    "/openapi.json",
    "/docs",
    "/docs/*",
  ]);
  for (const path of [
    "/station/bootstrap",
    "/kiosk/bootstrap",
    "/health",
    "/health/ready",
    "/openapi.json",
    "/docs",
    "/docs/swagger-ui.css",
  ]) {
    assert.ok(stationDevicePathMatches(caddy, path), `${path} must proxy`);
  }
  for (const path of ["/healthful", "/health-check", "/docs-old", "/docs2"]) {
    assert.ok(!stationDevicePathMatches(caddy, path), `${path} must remain a SPA path`);
  }
});

test("every API proxy has a finite route-appropriate transport timeout profile", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const reverseProxies = [...caddy.matchAll(/reverse_proxy api:3000\s*\{([\s\S]*?)^\s*\}/gm)].map(
    (match) => match[1],
  );

  assert.equal(reverseProxies.length, 12);
  assert.equal(
    reverseProxies.filter((block) => /import standard_api_transport/.test(block)).length,
    11,
  );
  assert.equal(
    reverseProxies.filter((block) => /import commerce_ml_transport/.test(block)).length,
    1,
  );
  assert.match(caddy, /@commerceMl path \/1c_exchange/);
  assert.match(caddy, /handle @commerceMl/);

  for (const [snippet, expected] of [
    ["standard_api_transport", standardProxyTimeouts],
    ["commerce_ml_transport", commerceMlProxyTimeouts],
  ]) {
    const block = caddy.match(new RegExp(`\\(${snippet}\\) \\{([\\s\\S]*?)^\\}`, "m"))?.[1] ?? "";
    assert.match(block, /transport http/);
    for (const [directive, duration] of Object.entries(expected)) {
      assert.match(block, new RegExp(`^\\s*${directive} ${duration}$`, "m"));
      assert.doesNotMatch(block, new RegExp(`^\\s*${directive} 0s$`, "m"));
    }
  }
});

test("direct Caddy adapter isolates the Markiro and v-b authorities", async () => {
  const directSource = await readFile("deploy/production/Caddyfile", "utf8");
  const direct = assertAuthorityContract(await adaptCaddy(directSource), { alb: false });
  assert.deepEqual(direct.adminTransports, [
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 300_000_000_000,
      response_header_timeout: 300_000_000_000,
      write_timeout: 300_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
    {
      protocol: "http",
      read_timeout: 60_000_000_000,
      response_header_timeout: 30_000_000_000,
      write_timeout: 60_000_000_000,
    },
  ]);
});

test("direct Caddy adapter exposes only the four exact legacy legal redirects", async () => {
  const adapted = await adaptCaddy(await readFile("deploy/production/Caddyfile", "utf8"));
  const landing = applicationRoute(adapted, landingHost);
  const routeTable = applicationOrderedRouteTable(landing);
  const expected = new Map([
    ["/d/MKR-PD-01/2026.08.01/2026-08-15", "/d/MKR-PD-01/2026.08/01/15.08.2026"],
    ["/d/MKR-PD-02/2026.08.01/2026-08-15", "/d/MKR-PD-02/2026.08/01/15.08.2026"],
    ["/d/MKR-DPA-01/2026.08.01/2026-08-15", "/d/MKR-DPA-01/2026.08/01/15.08.2026"],
    ["/d/MKR-BRD-01/2026.08.01/2026-08-15", "/d/MKR-BRD-01/2026.08/01/15.08.2026"],
  ]);
  const redirects = routeTable.filter((route) =>
    nestedObjects(route).some(
      (candidate) => candidate.handler === "static_response" && candidate.status_code === 308,
    ),
  );
  assert.equal(redirects.length, expected.size);
  for (const [legacyPath, target] of expected) {
    const matching = redirects.filter((route) =>
      adaptedRouteMatches(route, { method: "GET", path: legacyPath }),
    );
    assert.equal(matching.length, 1, `${legacyPath} must select one exact redirect`);
    const response = nestedObjects(matching[0]).find(
      (candidate) => candidate.handler === "static_response" && candidate.status_code === 308,
    );
    assert.deepEqual(response.headers?.Location, [target]);
  }

  for (const malformed of [
    "/d/MKR-PD-01/2026.08.01",
    "/d/mkr-pd-01/2026.08.01/2026-08-15",
    "/d/MKR-PD-01/2026.08.01/2026-08-15/extra",
    "/d/MKR-PD-99/2026.08.01/2026-08-15",
  ]) {
    assert.equal(
      redirects.some((route) => adaptedRouteMatches(route, { method: "GET", path: malformed })),
      false,
      `${malformed} must not match a legacy redirect`,
    );
  }
});

test("direct Caddy adapter keeps bare admin routes static and routes exact Station requests", async () => {
  const admin = applicationRoute(
    await adaptCaddy(await readFile("deploy/production/Caddyfile", "utf8")),
    adminHost,
  );
  const routeTable = applicationOrderedRouteTable(admin);

  for (const path of ["/shifts", "/products"]) {
    const request = { method: "GET", path };
    const selected = selectedAdaptedRoute(routeTable, request);
    assert.ok(
      nestedObjects(selected).some((candidate) => candidate.handler === "file_server"),
      `bare admin GET ${path} must remain an SPA navigation`,
    );
    assert.ok(
      nestedObjects(selected).every((candidate) => candidate.handler !== "reverse_proxy"),
      `bare admin GET ${path} must not proxy to the Station API`,
    );
  }

  for (const request of [
    { method: "GET", path: "/shifts", headers: { "x-api-key": "station-test-key" } },
    { method: "POST", path: "/shifts", headers: { "x-api-key": "station-test-key" } },
    { method: "GET", path: "/products", headers: { "x-api-key": "station-test-key" } },
    {
      method: "GET",
      path: "/shifts/box-label-templates",
      headers: { "x-api-key": "station-test-key" },
    },
    {
      method: "POST",
      path: "/products/gtin-check",
      headers: { "x-api-key": "station-test-key" },
    },
    {
      method: "POST",
      path: "/shifts/shift-1/open",
      headers: { "x-api-key": "station-test-key" },
    },
    {
      method: "GET",
      path: "/shifts/shift-1/bundle",
      headers: { "x-api-key": "station-test-key" },
    },
    {
      method: "GET",
      path: "/shifts/shift-1/reference-bundle",
      headers: { "x-api-key": "station-test-key" },
    },
    { method: "OPTIONS", path: "/shifts" },
    { method: "OPTIONS", path: "/shifts/box-label-templates" },
    { method: "OPTIONS", path: "/products" },
    { method: "OPTIONS", path: "/products/gtin-check" },
    { method: "OPTIONS", path: "/shifts/shift-1/open" },
    { method: "OPTIONS", path: "/shifts/shift-1/bundle" },
    { method: "OPTIONS", path: "/shifts/shift-1/reference-bundle" },
  ]) {
    const selected = selectedAdaptedRoute(routeTable, request);
    assert.equal(
      nestedObjects(selected).filter((candidate) => candidate.handler === "reverse_proxy").length,
      1,
      `${request.method} ${request.path} must proxy exactly once`,
    );
    assert.ok(
      nestedObjects(selected).every((candidate) => candidate.handler !== "file_server"),
      `${request.method} ${request.path} must not select the SPA`,
    );
  }

  const forbidden = {
    method: "POST",
    path: "/shifts/shift-1/close",
    headers: { "x-api-key": "station-test-key" },
  };
  assertOnlyPlain404(selectedAdaptedRoute(routeTable, forbidden), forbidden);
});

test("production edge preserves its image and routing contract", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS build-base/);
  assert.match(dockerfile, /FROM caddy:2\.11\.4-alpine AS runtime/);
  assertEdgeImageContract(dockerfile, dockerignore);
  assert.match(caddy, /reverse_proxy api:3000/);
  assert.match(caddy, /http_port 8080/);
  assert.match(caddy, /https_port 8443/);
  assert.match(caddy, /auto_https disable_redirects/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}\{uri\} permanent/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_KIOSK_DOMAIN\}\{uri\} permanent/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_LANDING_DOMAIN\}\{uri\} permanent/);
  assert.doesNotMatch(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}:8443/);
  assert.match(caddy, /root \* \/srv\/admin/);
  assert.match(caddy, /root \* \/srv\/kiosk/);
  assert.match(caddy, /root \* \/srv\/landing/);
  assert.match(caddy, /try_files \{path\} \/index\.html/);
  assert.match(caddy, /request_body/);
  assert.match(caddy, /max_size 4KB/);
  assert.doesNotMatch(caddy, /rate_limit/);

  assert.ok(caddy.includes(expectedApplicationCsp), "must include the exact application CSP");
  assert.ok(caddy.includes(expectedLandingCsp), "must include the exact landing CSP");
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options nosniff/);
  assert.match(caddy, /X-Frame-Options SAMEORIGIN/);
  assert.match(caddy, /Referrer-Policy strict-origin-when-cross-origin/);
  assert.match(caddy, /^\s*-Server\s*$/m);
  assert.match(caddy, /encode zstd gzip/);
  assert.match(caddy, /Cache-Control "public, max-age=31536000, immutable"/);
  assert.match(caddy, /Cache-Control "no-cache"/);
});

test("edge image mutations cannot omit or merge frontend build outputs", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const mutations = [
    mutate(dockerfile, " --filter @markiro/kiosk...", ""),
    dockerfile
      .replaceAll("/srv/admin", "/srv")
      .replaceAll("/srv/kiosk", "/srv")
      .replaceAll("/srv/landing", "/srv"),
    mutate(dockerfile, "COPY --from=application-build /workspace/apps/kiosk/dist /srv/kiosk\n", ""),
    mutate(dockerfile, "COPY --from=landing-build /workspace/apps/landing/dist /srv/landing\n", ""),
  ];
  assert.notEqual(mutations[1], dockerfile, "shared-root mutation must change the Dockerfile");

  for (const mutation of mutations) {
    assert.throws(() => assertEdgeImageContract(mutation, dockerignore));
  }
});

test("edge runtime rejects source COPY instructions even when frontend outputs remain", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const marker = "COPY --from=application-build /workspace/apps/kiosk/dist /srv/kiosk\n";
  const sourceCopies = [
    mutate(dockerfile, marker, `${marker}COPY apps/kiosk /srv/source\n`),
    mutate(dockerfile, marker, `${marker}copy apps/kiosk /srv/source\n`),
  ];

  for (const sourceCopy of sourceCopies) {
    assert.throws(() => assertEdgeImageContract(sourceCopy, dockerignore));
  }
});

test("edge runtime COPY allowlist stops at the next Dockerfile stage", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const laterStage = `${dockerfile}\nFROM scratch AS metadata\nCOPY apps/kiosk /metadata/source\n`;

  assert.doesNotThrow(() => assertEdgeImageContract(laterStage, dockerignore));
});

test("edge runtime COPY parser ignores FROM text inside a continued RUN", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const spoofedBoundary = mutate(
    dockerfile,
    "EXPOSE 8080 8443\n",
    "RUN printf '%s\\n' \\\nFROM scratch AS metadata\ncopy apps/kiosk /srv/source\nEXPOSE 8080 8443\n",
  );

  assert.throws(
    () => assertEdgeImageContract(spoofedBoundary, dockerignore),
    /apps\/kiosk \/srv\/source/,
  );
});

test("edge runtime COPY parser rejects non-default escape directives", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const nonDefaultEscape = `# escape=\`\n${dockerfile}`;
  const spoofedBoundary = mutate(
    nonDefaultEscape,
    "EXPOSE 8080 8443\n",
    "RUN printf '%s\\n' `\nFROM scratch AS metadata\ncopy apps/kiosk /srv/source\nEXPOSE 8080 8443\n",
  );

  assert.throws(
    () => assertEdgeImageContract(spoofedBoundary, dockerignore),
    /non-default Dockerfile escape directives are unsupported/,
  );
});

test("edge runtime COPY parser rejects unsupported heredoc instructions", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const spoofedBoundary = mutate(
    dockerfile,
    "EXPOSE 8080 8443\n",
    "RUN <<EOF\nFROM scratch AS metadata\nEOF\ncopy apps/kiosk /srv/source\nEXPOSE 8080 8443\n",
  );

  assert.throws(
    () => assertEdgeImageContract(spoofedBoundary, dockerignore),
    /heredoc instructions are unsupported/,
  );
});

test("Caddy contracts reject cross-host and overbroad kiosk mutations", async () => {
  for (const [file, alb] of [["deploy/production/Caddyfile", false]]) {
    const source = await readFile(file, "utf8");
    const swappedRoots = mutate(source, "/srv/admin", "/srv/root-swap")
      .replace("/srv/kiosk", "/srv/admin")
      .replace("/srv/root-swap", "/srv/kiosk");
    const mutations = [
      swappedRoots,
      mutate(source, "{$MARKIRO_KIOSK_DOMAIN}", "*.{$MARKIRO_KIOSK_DOMAIN}"),
      mutate(source, "@kioskApi path /api/kiosk/*", "@kioskApi path /api/*"),
      mutate(source, /^\s*uri strip_prefix \/api\n/m, ""),
      mutate(source, "@kioskSpa method GET HEAD", "@kioskSpa method GET HEAD POST"),
    ];

    for (const mutation of mutations) {
      await assert.rejects(async () => {
        assertAuthorityContract(await adaptCaddy(mutation), { alb });
      });
    }
  }
});

test("Caddy contracts reject an application route without an exact Host", async () => {
  for (const [file, alb] of [["deploy/production/Caddyfile", false]]) {
    const source = await readFile(file, "utf8");
    const catchAllAddress = alb ? ":8080 {" : ":8443 {";
    const catchAll = `${source}\n${catchAllAddress}\n\timport common_headers\n\timport kiosk_routes\n}\n`;
    assert.notEqual(catchAll, source);

    await assert.rejects(async () => {
      assertAuthorityContract(await adaptCaddy(catchAll), { alb });
    });
  }
});

test("Caddy contracts reject an unconditional kiosk reverse proxy", async () => {
  for (const [file, alb] of [["deploy/production/Caddyfile", false]]) {
    const source = await readFile(file, "utf8");
    const forwardedProto = alb ? "\t\t\t\theader_up X-Forwarded-Proto https\n" : "";
    const unconditionalProxy = mutate(
      source,
      "(kiosk_routes) {\n\troot * /srv/kiosk\n\troute {",
      `(kiosk_routes) {\n\troot * /srv/kiosk\n\troute {\n\t\thandle {\n\t\t\treverse_proxy api:3000 {\n${forwardedProto}\t\t\t\timport standard_api_transport\n\t\t\t}\n\t\t}`,
    );

    await assert.rejects(async () => {
      assertAuthorityContract(await adaptCaddy(unconditionalProxy), { alb });
    });
  }
});

test("Caddy contracts reject reserved kiosk namespace routing mutations", async () => {
  for (const file of ["deploy/production/Caddyfile"]) {
    const source = await readFile(file, "utf8");
    const reservedLine = `\t\t@kioskReserved path ${kioskReservedPatterns.join(" ")}`;
    assert.ok(source.includes(reservedLine), `${file} must contain the reserved matcher`);

    for (const pattern of kioskReservedPatterns) {
      const missingNamespace = mutate(
        source,
        reservedLine,
        `\t\t@kioskReserved path ${kioskReservedPatterns
          .filter((candidate) => candidate !== pattern)
          .join(" ")}`,
      );
      await assert.rejects(async () => {
        assertKioskRoutingBoundary(applicationRoute(await adaptCaddy(missingNamespace), kioskHost));
      });
    }

    const reservedBlock = `${reservedLine}\n\t\thandle @kioskReserved {\n\t\t\trespond 404\n\t\t}`;
    for (const replacement of [
      `${reservedLine}\n\t\thandle @kioskReserved {\n\t\t\troot * /srv/kiosk\n\t\t\tfile_server\n\t\t}`,
      `${reservedLine}\n\t\thandle @kioskReserved {\n\t\t\ttry_files {path} /index.html\n\t\t\tfile_server\n\t\t}`,
      `${reservedLine}\n\t\thandle @kioskReserved {\n\t\t\treverse_proxy api:3000\n\t\t}`,
    ]) {
      const non404ReservedRoute = mutate(source, reservedBlock, replacement);
      await assert.rejects(async () => {
        assertKioskRoutingBoundary(
          applicationRoute(await adaptCaddy(non404ReservedRoute), kioskHost),
        );
      });
    }

    const apiBlock = source.match(/\t\t@kioskApi path[\s\S]*?\n\t\t}\n\n/)?.[0];
    assert.ok(apiBlock, `${file} must contain the kiosk API handler before reserved paths`);
    const reordered = mutate(
      source,
      `${apiBlock}${reservedBlock}\n\n`,
      `${reservedBlock}\n\n${apiBlock}`,
    );
    await assert.rejects(async () => {
      assertKioskRoutingBoundary(applicationRoute(await adaptCaddy(reordered), kioskHost));
    });
  }
});

test("edge runtime accepts only the fixed direct Caddyfile without dynamic evaluation", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const entrypoint = await readFile("deploy/production/edge-entrypoint.sh", "utf8");

  assert.match(dockerfile, /COPY deploy\/production\/Caddyfile \/etc\/caddy\/Caddyfile/);
  assert.match(
    dockerfile,
    /COPY deploy\/production\/edge-entrypoint\.sh \/usr\/bin\/edge-entrypoint/,
  );
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/edge-entrypoint"\]/);
  assert.match(entrypoint, /MARKIRO_EDGE_MODE:-direct/);
  assert.doesNotMatch(entrypoint, /behind-alb|Caddyfile\.alb/);
  assert.match(entrypoint, /exec caddy run --config \/etc\/caddy\/Caddyfile --adapter caddyfile/);
  assert.doesNotMatch(entrypoint, /\beval\b|\$\(|`/);
});
