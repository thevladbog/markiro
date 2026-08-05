import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

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

function caddyPathMatches(pattern, path) {
  return pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern;
}

function nestedObjects(value) {
  if (value === null || typeof value !== "object") return [];
  return [value, ...Object.values(value).flatMap(nestedObjects)];
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

  assert.equal(reverseProxies.length, 4);
  assert.equal(
    reverseProxies.filter((block) => /import standard_api_transport/.test(block)).length,
    3,
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

test("Caddy adapt emits the exact API route table and finite proxy transports", () => {
  const caddyfile = resolve("deploy/production/Caddyfile");
  const adapted = JSON.parse(
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-v",
        `${caddyfile}:/etc/caddy/Caddyfile:ro`,
        "-e",
        "MARKIRO_DOMAIN=localhost",
        "-e",
        "ACME_EMAIL=ops@example.test",
        "caddy:2.11.4-alpine",
        "caddy",
        "adapt",
        "--config",
        "/etc/caddy/Caddyfile",
      ],
      { encoding: "utf8" },
    ),
  );
  const apiRoutes = nestedObjects(adapted)
    .filter((candidate) => Array.isArray(candidate.match))
    .map((candidate) => ({
      paths: candidate.match.flatMap((matcher) => matcher.path ?? []),
      proxies: nestedObjects(candidate.handle).filter(
        (handler) => handler.handler === "reverse_proxy",
      ),
    }))
    .filter(({ paths, proxies }) => paths.length > 0 && proxies.length > 0);

  assert.deepEqual(
    apiRoutes.map(({ paths }) => paths),
    [
      ["/api/auth/*"],
      ["/api/*"],
      ["/1c_exchange"],
      ["/station/*", "/kiosk/*", "/health", "/health/*", "/openapi.json", "/docs", "/docs/*"],
    ],
  );
  assert.deepEqual(
    apiRoutes.map(({ proxies }) => proxies[0].transport),
    [
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
    ],
  );
  assert.ok(apiRoutes.every(({ proxies }) => proxies.length === 1));
});

test("production edge preserves its image and routing contract", async () => {
  const caddy = await readFile("deploy/production/Caddyfile", "utf8");
  const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS build/);
  assert.match(dockerfile, /FROM caddy:2\.11\.4-alpine AS runtime/);
  assert.match(dockerfile, /turbo build --filter @markiro\/admin\.\.\./);
  assert.match(dockerfile, /COPY --from=build \/workspace\/apps\/admin\/dist \/srv/);
  assert.match(dockerfile, /addgroup -S -g 10001 markiro/);
  assert.match(dockerfile, /setcap -r \/usr\/bin\/caddy/);
  assert.match(dockerfile, /USER 10001:10001/);
  const runtime = dockerfile.split("FROM caddy:2.11.4-alpine AS runtime")[1];
  assert.doesNotMatch(runtime, /node|pnpm/);
  assert.doesNotMatch(
    runtime,
    /COPY(?:\s+--[^\s]+)*\s+[^\s]*workspace\/apps\/(?!admin\/dist\s+\/srv)/,
  );

  for (const buildInput of [
    "!apps/",
    "!apps/admin/",
    "!apps/admin/**",
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

  const ordered = [
    "@apiAuth path /api/auth/*",
    "handle @apiAuth",
    "handle_path /api/*",
    "@commerceMl path /1c_exchange",
    "handle @commerceMl",
    "@device path /station/* /kiosk/* /health /health/* /openapi.json /docs /docs/*",
    "handle @device",
    "@assets path /assets/*",
    "handle @assets",
    "@spa method GET HEAD",
    "handle @spa",
    "respond 404",
  ];
  let cursor = -1;
  for (const token of ordered) {
    const next = caddy.indexOf(token);
    assert.ok(next > cursor, `${token} must appear in route order`);
    cursor = next;
  }
  assert.match(caddy, /reverse_proxy api:3000/);
  assert.match(caddy, /http_port 8080/);
  assert.match(caddy, /https_port 8443/);
  assert.match(caddy, /auto_https disable_redirects/);
  assert.match(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}\{uri\} permanent/);
  assert.doesNotMatch(caddy, /redir https:\/\/\{\$MARKIRO_DOMAIN\}:8443/);
  assert.match(caddy, /root \* \/srv/);
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
  ]) {
    assert.ok(direct.includes(marker));
    assert.ok(alb.includes(marker));
  }
  assert.match(alb, /http:\/\/\{\$MARKIRO_DOMAIN\}:8080/);
  assert.doesNotMatch(alb, /https:\/\/|ACME_EMAIL|redir https/);
  assert.match(alb, /header_up X-Forwarded-Proto https/);
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
