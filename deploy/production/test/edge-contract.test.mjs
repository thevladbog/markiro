import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const expectedCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";

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
const kioskHost = "kiosk.example.test";

function caddyPathMatches(pattern, path) {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

function nestedObjects(value) {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nestedObjects)];
}

async function adaptCaddy(source) {
  const directory = await mkdtemp(join(tmpdir(), "markiro-caddy-contract-"));
  const caddyfile = join(directory, "Caddyfile");
  await writeFile(caddyfile, source);
  try {
    return JSON.parse(
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-v",
          `${caddyfile}:/etc/caddy/Caddyfile:ro`,
          "-e",
          `MARKIRO_DOMAIN=${adminHost}`,
          "-e",
          `MARKIRO_KIOSK_DOMAIN=${kioskHost}`,
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
      paths: candidate.match.flatMap((matcher) => matcher.path ?? []),
      proxies: nestedObjects(candidate.handle).filter(
        (handler) => handler.handler === "reverse_proxy",
      ),
      rewrites: nestedObjects(candidate.handle).filter((handler) => handler.handler === "rewrite"),
    }))
    .filter(({ paths, proxies }) => paths.length > 0 && proxies.length > 0);
}

function assertPlainFallback(route, host) {
  const routeTable = nestedObjects(route).find(
    (candidate) =>
      Array.isArray(candidate.routes) &&
      candidate.routes.some((entry) =>
        nestedObjects(entry).some((value) => value.handler === "reverse_proxy"),
      ),
  )?.routes;
  assert.ok(routeTable, `${host} must have an ordered route table`);
  const fallback = nestedObjects(routeTable.at(-1)).filter(
    (candidate) => candidate.handler === "static_response",
  );
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
  const approvedHosts = [adminHost, kioskHost];
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
  assert.deepEqual(hosts, [adminHost, kioskHost]);

  const admin = applicationRoute(adapted, adminHost);
  const kiosk = applicationRoute(adapted, kioskHost);
  for (const [host, route, expectedRoot] of [
    [adminHost, admin, "/srv/admin"],
    [kioskHost, kiosk, "/srv/kiosk"],
  ]) {
    const roots = nestedObjects(route)
      .filter((candidate) => candidate.handler === "vars" && typeof candidate.root === "string")
      .map((candidate) => candidate.root);
    assert.deepEqual(roots, [expectedRoot], `${host} must use only ${expectedRoot}`);

    const headerSets = nestedObjects(route)
      .filter((candidate) => candidate.handler === "headers")
      .map((candidate) => candidate.response?.set ?? {});
    assert.ok(
      headerSets.some(
        (headers) =>
          headers["X-Markiro-Release-Sha"]?.[0] === "contract-sha" &&
          headers["Content-Security-Policy"]?.[0] === expectedCsp &&
          headers["Strict-Transport-Security"]?.[0] === "max-age=63072000; includeSubDomains" &&
          headers["X-Content-Type-Options"]?.[0] === "nosniff" &&
          headers["X-Frame-Options"]?.[0] === "SAMEORIGIN" &&
          headers["Referrer-Policy"]?.[0] === "strict-origin-when-cross-origin",
      ),
      `${host} must emit the common security and release headers`,
    );
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
    assert.deepEqual(methods, [["GET", "HEAD"]], `${host} must not serve the SPA for mutations`);
    assertPlainFallback(route, host);
  }

  const expectedAdminPaths = [
    ["/api/auth/*"],
    ["/api/*"],
    ["/1c_exchange"],
    ["/station/*", "/kiosk/*", "/health", "/health/*", "/openapi.json", "/docs", "/docs/*"],
  ];
  const adminProxies = proxyRoutes(admin);
  const adminReverseProxies = nestedObjects(admin).filter(
    (candidate) => candidate.handler === "reverse_proxy",
  );
  assert.equal(adminReverseProxies.length, 4);
  assert.deepEqual(
    adminProxies.map(({ paths }) => paths),
    expectedAdminPaths,
  );
  assert.ok(adminProxies.every(({ proxies }) => proxies.length === 1));

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
  const kioskMatcherPaths = nestedObjects(kiosk)
    .filter((candidate) => Array.isArray(candidate.path))
    .flatMap((candidate) => candidate.path);
  for (const forbidden of [
    "/api/auth/*",
    "/api/*",
    "/1c_exchange",
    "/station/*",
    "/health",
    "/health/*",
    "/openapi.json",
    "/docs",
    "/docs/*",
  ]) {
    assert.ok(!kioskMatcherPaths.includes(forbidden), `${kioskHost} must not match ${forbidden}`);
  }
  for (const proxy of [...adminReverseProxies, ...kioskReverseProxies]) {
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
  const install = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
  const adminManifest = dockerfile.indexOf("COPY apps/admin/package.json");
  const kioskManifest = dockerfile.indexOf("COPY apps/kiosk/package.json");
  const adminSource = dockerfile.indexOf("COPY apps/admin ./apps/admin");
  const kioskSource = dockerfile.indexOf("COPY apps/kiosk ./apps/kiosk");
  const build = dockerfile.indexOf(
    "RUN pnpm turbo build --filter @markiro/admin... --filter @markiro/kiosk...",
  );
  assert.ok(adminManifest >= 0 && adminManifest < install);
  assert.ok(kioskManifest >= 0 && kioskManifest < install);
  assert.ok(adminSource > install && adminSource < build);
  assert.ok(kioskSource > install && kioskSource < build);
  assert.ok(build > install);

  const runtimeInstructions = dockerfileStageInstructions(dockerfile, "runtime");
  const runtime = runtimeInstructions
    .map((instruction) => `${instruction.name} ${instruction.arguments}`)
    .join("\n");
  assert.match(runtime, /COPY --from=build \/workspace\/apps\/admin\/dist \/srv\/admin/);
  assert.match(runtime, /COPY --from=build \/workspace\/apps\/kiosk\/dist \/srv\/kiosk/);
  assert.match(runtime, /addgroup -S -g 10001 markiro/);
  assert.match(runtime, /setcap -r \/usr\/bin\/caddy/);
  assert.match(runtime, /USER 10001:10001/);
  assert.doesNotMatch(runtime, /node|pnpm/);
  const runtimeCopies = runtimeInstructions
    .filter((instruction) => instruction.name === "COPY")
    .map((instruction) => instruction.arguments);
  assert.deepEqual(runtimeCopies, [
    "deploy/production/Caddyfile /etc/caddy/Caddyfile.direct",
    "deploy/production/Caddyfile.alb /etc/caddy/Caddyfile.alb",
    "deploy/production/edge-entrypoint.sh /usr/bin/edge-entrypoint",
    "--from=build /workspace/apps/admin/dist /srv/admin",
    "--from=build /workspace/apps/kiosk/dist /srv/kiosk",
  ]);
  const buildCopies = runtimeCopies
    .filter((copy) => copy.startsWith("--from=build "))
    .map((copy) => copy.slice("--from=build ".length));
  assert.deepEqual(buildCopies, [
    "/workspace/apps/admin/dist /srv/admin",
    "/workspace/apps/kiosk/dist /srv/kiosk",
  ]);

  for (const buildInput of [
    "!apps/",
    "!apps/admin/",
    "!apps/admin/**",
    "!apps/kiosk/",
    "!apps/kiosk/**",
    "!packages/",
    "!packages/ui/",
    "!packages/ui/**",
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

function mutate(source, search, replacement) {
  const changed = source.replace(search, replacement);
  assert.notEqual(changed, source, `mutation must replace ${String(search)}`);
  return changed;
}

test("device proxy matcher accepts exact and nested health/docs boundaries only", async () => {
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
    assert.ok(
      patterns.some((pattern) => caddyPathMatches(pattern, path)),
      `${path} must proxy`,
    );
  }
  for (const path of ["/healthful", "/health-check", "/docs-old", "/docs2"]) {
    assert.ok(
      patterns.every((pattern) => !caddyPathMatches(pattern, path)),
      `${path} must remain a SPA path`,
    );
  }
});

test("every API proxy has a finite route-appropriate transport timeout profile", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const reverseProxies = [...caddy.matchAll(/reverse_proxy api:3000\s*\{([\s\S]*?)^\s*\}/gm)].map(
    (match) => match[1],
  );

  assert.equal(reverseProxies.length, 5);
  assert.equal(
    reverseProxies.filter((block) => /import standard_api_transport/.test(block)).length,
    4,
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

test("direct and ALB Caddy adapters isolate the admin and kiosk authorities", async () => {
  const [directSource, albSource] = await Promise.all([
    readFile("deploy/production/Caddyfile", "utf8"),
    readFile("deploy/production/Caddyfile.alb", "utf8"),
  ]);
  const direct = assertAuthorityContract(await adaptCaddy(directSource), { alb: false });
  const alb = assertAuthorityContract(await adaptCaddy(albSource), { alb: true });

  assert.deepEqual(direct, alb);
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
  ]);
});

test("production edge preserves its image and routing contract", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS build/);
  assert.match(dockerfile, /FROM caddy:2\.11\.4-alpine AS runtime/);
  assertEdgeImageContract(dockerfile, dockerignore);
  assert.match(caddy, /reverse_proxy api:3000/);
  assert.match(caddy, /http_port 8080/);
  assert.match(caddy, /https_port 8443/);
  assert.match(caddy, /auto_https disable_redirects/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}\{uri\} permanent/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_KIOSK_DOMAIN\}\{uri\} permanent/);
  assert.doesNotMatch(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}:8443/);
  assert.match(caddy, /root \* \/srv\/admin/);
  assert.match(caddy, /root \* \/srv\/kiosk/);
  assert.match(caddy, /try_files \{path\} \/index\.html/);
  assert.doesNotMatch(caddy, /request_body|max_size|rate_limit/);

  assert.ok(caddy.includes(expectedCsp), "must include the exact CSP");
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
    dockerfile.replaceAll("/srv/admin", "/srv").replaceAll("/srv/kiosk", "/srv"),
    mutate(dockerfile, "COPY --from=build /workspace/apps/kiosk/dist /srv/kiosk\n", ""),
  ];
  assert.notEqual(mutations[1], dockerfile, "shared-root mutation must change the Dockerfile");

  for (const mutation of mutations) {
    assert.throws(() => assertEdgeImageContract(mutation, dockerignore));
  }
});

test("edge runtime rejects source COPY instructions even when frontend outputs remain", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");
  const marker = "COPY --from=build /workspace/apps/kiosk/dist /srv/kiosk\n";
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
  for (const [file, alb] of [
    ["deploy/production/Caddyfile", false],
    ["deploy/production/Caddyfile.alb", true],
  ]) {
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
  for (const [file, alb] of [
    ["deploy/production/Caddyfile", false],
    ["deploy/production/Caddyfile.alb", true],
  ]) {
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
  for (const [file, alb] of [
    ["deploy/production/Caddyfile", false],
    ["deploy/production/Caddyfile.alb", true],
  ]) {
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

test("ALB mode keeps route parity but owns no certificate", async () => {
  const direct = await readFile("deploy/production/Caddyfile", "utf8");
  const alb = await readFile("deploy/production/Caddyfile.alb", "utf8");
  for (const marker of [
    "@apiAuth path /api/auth/*",
    "handle_path /api/*",
    "@commerceMl path /1c_exchange",
    "@device path /station/* /kiosk/* /health /health/* /openapi.json /docs /docs/*",
    "@assets path /assets/*",
    "@spa method GET HEAD",
    "@kioskApi path /api/kiosk/*",
    "@kioskAssets path /assets/*",
    "@kioskSpa method GET HEAD",
  ]) {
    assert.ok(direct.includes(marker));
    assert.ok(alb.includes(marker));
  }
  assert.match(alb, /http:\/\/\{\$MARKIRO_DOMAIN\}:8080/);
  assert.match(alb, /http:\/\/\{\$MARKIRO_KIOSK_DOMAIN\}:8080/);
  assert.doesNotMatch(alb, /https:\/\/|ACME_EMAIL|redir https/);
  assert.match(alb, /header_up X-Forwarded-Proto https/);
  for (const caddy of [direct, alb]) {
    assert.match(caddy, /X-Markiro-Release-Sha "\{\$MARKIRO_RELEASE_SHA\}"/);
  }
});

test("edge runtime selects a fixed direct or ALB Caddyfile without dynamic evaluation", async () => {
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const entrypoint = await readFile("deploy/production/edge-entrypoint.sh", "utf8");

  assert.match(dockerfile, /COPY deploy\/production\/Caddyfile \/etc\/caddy\/Caddyfile\.direct/);
  assert.match(dockerfile, /COPY deploy\/production\/Caddyfile\.alb \/etc\/caddy\/Caddyfile\.alb/);
  assert.match(
    dockerfile,
    /COPY deploy\/production\/edge-entrypoint\.sh \/usr\/bin\/edge-entrypoint/,
  );
  assert.match(dockerfile, /ENTRYPOINT \["\/usr\/bin\/edge-entrypoint"\]/);
  assert.match(entrypoint, /direct\)/);
  assert.match(entrypoint, /behind-alb\)/);
  assert.match(entrypoint, /config=\/etc\/caddy\/Caddyfile\.direct/);
  assert.match(entrypoint, /config=\/etc\/caddy\/Caddyfile\.alb/);
  assert.match(entrypoint, /exec caddy run --config "\$config" --adapter caddyfile/);
  assert.doesNotMatch(entrypoint, /\beval\b|\$\(|`/);
});
