import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const expectedCsp =
  "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'";

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
    "@device path /station/* /kiosk/* /1c_exchange /health* /openapi.json /docs*",
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
