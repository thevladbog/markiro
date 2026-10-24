import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CORE_SCHEMA, Schema, defineSequenceTag, load } from "js-yaml";
import { parseReleaseManifest } from "../../production/release-manifest.mjs";
import { createPlatformManifest, parsePlatformManifest } from "../release-manifest.mjs";
import { RELEASES_UPLOAD_ORIGIN, readProtectedEnv, validateConfig } from "../preflight.mjs";
import { classifyChangedFiles } from "../../../tools/ci/affected.mjs";

const read = (path) => readFileSync(path, "utf8");
const sha = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
const manifest = () =>
  createPlatformManifest({
    sourceSha: sha,
    toolingSha: sha,
    apiDigest: digest,
    edgeDigest: digest,
    workflowRunId: "123",
    createdAt: "2026-10-18T00:00:00.000Z",
  });
const databasePassword = randomBytes(24).toString("hex");
const databaseUrl = () => {
  const url = new URL("postgresql://db.private:5432/markiro");
  url.username = "test";
  url.password = databasePassword;
  url.searchParams.set("sslmode", "verify-full");
  return url;
};
const env = () => ({
  SERVER_PROFILE: "platform-only",
  VITE_SERVER_PROFILE: "platform-only",
  MARKIRO_SOURCE_SHA: sha,
  MARKIRO_TOOLING_SHA: sha,
  MARKIRO_API_IMAGE_DIGEST: digest,
  MARKIRO_PLATFORM_EDGE_IMAGE_DIGEST: digest,
  MARKIRO_SAAS_ADMIN_DOMAIN: "saas-admin.markiro.app",
  MARKIRO_LANDING_DOMAIN: "markiro.app",
  MARKIRO_RETIRED_ADMIN_DOMAIN: "admin.markiro.app",
  MARKIRO_RETIRED_KIOSK_DOMAIN: "kiosk.markiro.app",
  MARKIRO_RELEASES_DOMAIN: "releases.markiro.app",
  MARKIRO_RELEASES_BUCKET: "markiro-releases",
  SAAS_ADMIN_ORIGIN: "https://saas-admin.markiro.app",
  PLATFORM_AUTH_URL: "https://saas-admin.markiro.app",
  LANDING_ORIGIN: "https://markiro.app",
  S3_ENDPOINT: "https://s3.example.org",
  S3_PUBLIC_ORIGIN: "https://s3.example.org",
  S3_REGION: "region",
  S3_BUCKET: "markiro-private",
  S3_ACCESS_KEY_ID: "test-access",
  S3_SECRET_ACCESS_KEY: "test-secret",
  S3_FORCE_PATH_STYLE: "true",
  DATABASE_URL: databaseUrl().href,
  PLATFORM_AUTH_SECRET: "test-platform-secret-".repeat(3),
  MAIL_PAYLOAD_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
  SMTP_HOST: "smtp.example.org",
  SMTP_PORT: "465",
  SMTP_SECURE: "true",
  SMTP_USER: "sender",
  SMTP_PASSWORD: "test-password",
  SMTP_FROM_EMAIL: "mail@markiro.app",
  SMTP_FROM_NAME: "Markiro",
  ACME_EMAIL: "ops@markiro.app",
  LANDING_DEMO_SUBMISSION_ENABLED: "false",
});

test("versioned platform manifest binds profiles and distinct image identity; legacy rejects it", () => {
  const value = manifest();
  assert.equal(value.serverProfile, "platform-only");
  assert.equal(value.uiProfile, "platform-only");
  assert.match(value.edge, /^ghcr.io\/thevladbog\/markiro-platform-edge@sha256:/);
  assert.deepEqual(parsePlatformManifest(JSON.stringify(value), "123"), value);
  assert.throws(() => parseReleaseManifest(JSON.stringify(value), "123"));
  for (const patch of [
    { serverProfile: "legacy" },
    { uiProfile: "legacy" },
    { version: 2 },
    { extra: true },
    { edge: value.edge.replace("platform-edge", "edge") },
    { sourceSha: "main" },
    { toolingSha: "main" },
  ])
    assert.throws(() => parsePlatformManifest(JSON.stringify({ ...value, ...patch }), "123"));
  assert.throws(() => parsePlatformManifest(JSON.stringify(value), "124"));
});

test("configuration fails closed on profiles, origins, digest, secret and manifest mismatch", () => {
  const noTlsDatabaseUrl = databaseUrl();
  noTlsDatabaseUrl.searchParams.delete("sslmode");
  assert.doesNotThrow(() => validateConfig(env(), manifest()));
  for (const key of Object.keys(env())) {
    const value = env();
    delete value[key];
    assert.throws(() => validateConfig(value, manifest()), undefined, key);
  }
  for (const patch of [
    { SERVER_PROFILE: "legacy" },
    { VITE_SERVER_PROFILE: "legacy" },
    { MARKIRO_API_IMAGE_DIGEST: "latest" },
    { MARKIRO_TOOLING_SHA: "c".repeat(40) },
    { MARKIRO_SAAS_ADMIN_DOMAIN: "*.markiro.app" },
    { MARKIRO_RETIRED_ADMIN_DOMAIN: "markiro.app" },
    { MARKIRO_RELEASES_DOMAIN: "markiro.app" },
    { MARKIRO_RELEASES_DOMAIN: "releases.markiro.app." },
    { MARKIRO_RELEASES_BUCKET: "Releases" },
    // The public release host must never serve the private media bucket.
    { MARKIRO_RELEASES_BUCKET: "markiro-private" },
    { SAAS_ADMIN_ORIGIN: "https://evil.test" },
    { PLATFORM_AUTH_URL: "https://saas-admin.markiro.app/api" },
    { S3_PUBLIC_ORIGIN: "https://s3.example.org; script-src *" },
    { S3_PUBLIC_ORIGIN: "https://s3.example.org/" },
    { S3_ENDPOINT: "http://s3.example.org" },
    { DATABASE_URL: noTlsDatabaseUrl.href },
    { SMTP_SECURE: "false" },
    { LANDING_DEMO_SUBMISSION_ENABLED: "true" },
    { BETTER_AUTH_SECRET: "legacy" },
  ])
    assert.throws(
      () => validateConfig({ ...env(), ...patch }, manifest()),
      undefined,
      JSON.stringify(Object.keys(patch)),
    );
});

test("runtime env is explicit, owned, regular and protected; duplicates and interpolation rejected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "markiro-platform-contract-"));
  const file = join(dir, "runtime.env");
  try {
    await writeFile(file, "SERVER_PROFILE=platform-only\nSMTP_PASSWORD=literal$secret#value\n", {
      mode: 0o600,
    });
    assert.equal((await readProtectedEnv(file)).SMTP_PASSWORD, "literal$secret#value");
    await symlink(file, join(dir, "link"));
    await assert.rejects(readProtectedEnv(join(dir, "link")));
    await assert.rejects(readProtectedEnv(dir));
    await assert.rejects(readProtectedEnv("relative.env"));
    await chmod(file, 0o644);
    await assert.rejects(readProtectedEnv(file));
    await chmod(file, 0o600);
    for (const text of ["A=1\nA=2\n", "export A=1\n", 'A="quoted"\n', "A=${OTHER}\n"]) {
      await writeFile(file, text);
      await assert.rejects(readProtectedEnv(file));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("portable topology exposes only hardened edge, pins API profile and raw protected file", () => {
  const compose = load(read("deploy/platform/compose.yml"));
  assert.deepEqual(Object.keys(compose.services).sort(), ["api", "edge", "migrate"]);
  for (const key of ["api", "migrate"]) {
    const svc = compose.services[key];
    assert.equal(svc.environment.SERVER_PROFILE, "platform-only");
    assert.equal(svc.ports, undefined);
    assert.equal(svc.env_file[0].format, "raw");
    assert.match(
      svc.env_file[0].path,
      key === "api" ? /MARKIRO_PLATFORM_ENV_FILE:\?/ : /MARKIRO_PLATFORM_MIGRATION_ENV_FILE:\?/,
    );
  }
  assert.deepEqual(compose.services.api.healthcheck.test, [
    "CMD",
    "node",
    "/opt/markiro/healthcheck.mjs",
  ]);
  for (const svc of Object.values(compose.services)) {
    assert.equal(svc.read_only, true);
    assert.deepEqual(svc.cap_drop, ["ALL"]);
    assert.deepEqual(svc.security_opt, ["no-new-privileges:true"]);
  }
  assert.match(compose.services.edge.image, /markiro-platform-edge@/);
  assert.doesNotMatch(read("deploy/platform/compose.yml"), /vbtech|Lockbox|169\.254\.169\.254/i);
});

test("platform edge builds only SaaS and landing, with immutable UI profile and legal verifier", () => {
  const dockerfile = read("deploy/platform/edge.Dockerfile");
  assert.doesNotMatch(
    dockerfile,
    /apps\/(?:admin|kiosk)|@markiro\/(?:admin|kiosk)|\/srv\/(?:admin|kiosk)|vbtech/i,
  );
  assert.match(dockerfile, /ENV VITE_SERVER_PROFILE=platform-only/);
  assert.match(dockerfile, /verify-legal-artifacts\.mjs/);
  assert.match(dockerfile, /--network=none/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(read(".dockerignore"), /!deploy\/platform\/Caddyfile/);
});

test("edge excludes legacy API from SPA and retirement returns machine 410 without redirects", () => {
  const caddy = read("deploy/platform/Caddyfile");
  assert.match(caddy, /\{\$S3_PUBLIC_ORIGIN\}/);
  assert.match(caddy, /@platformReserved path \/api \/api\/\*/);
  assert.match(caddy, /@retiredMachine/);
  assert.match(caddy, /respond.*410/);
  assert.match(caddy, /method GET HEAD/);
  assert.doesNotMatch(caddy, /vbtech|\/srv\/admin|\/srv\/kiosk/);
  const retired = caddy.slice(caddy.indexOf("(retired_routes)"), caddy.indexOf("http://"));
  assert.doesNotMatch(retired, /redir/);
});

test("landing moves the retired film and kiosk pages permanently to the home page of their language", () => {
  const caddy = read("deploy/platform/Caddyfile");
  const landing = caddy.slice(
    caddy.indexOf("(landing_routes) {"),
    caddy.indexOf("(releases_headers)"),
  );
  const variants = (page) =>
    [page, `${page}/`, `${page}/*`, `${page}.md`]
      .join(" ")
      .replace(/[.*/]/gu, (character) => `\\${character}`);
  assert.match(
    landing,
    new RegExp(
      `@retiredRu \\{\\n\\t\\t\\tmethod GET HEAD\\n\\t\\t\\tpath ${variants("/kak-rabotaet")} ${variants("/kiosk-samovydachi")}\\n\\t\\t\\}\\n\\t\\thandle @retiredRu \\{\\n\\t\\t\\tredir \\* /\\{http\\.request\\.uri\\.prefixed_query\\} 301\\n`,
      "u",
    ),
  );
  assert.match(
    landing,
    new RegExp(
      `@retiredEn \\{\\n\\t\\t\\tmethod GET HEAD\\n\\t\\t\\tpath ${variants("/en/how-it-works")} ${variants("/en/self-service-pickup-kiosk")}\\n\\t\\t\\}\\n\\t\\thandle @retiredEn \\{\\n\\t\\t\\tredir \\* /en/\\{http\\.request\\.uri\\.prefixed_query\\} 301\\n`,
      "u",
    ),
  );
  // The redirects come before the static, canonical-form and document handlers.
  for (const later of [
    "@landingAssets",
    "@landingIndexFile",
    "@landingDirectory",
    "@landingDocument",
  ])
    assert.ok(landing.indexOf("handle @retiredEn") < landing.indexOf(later), later);
});

test("CI routes platform files to bundle checks and builds isolated preparation without publishing", () => {
  for (const path of ["deploy/platform/Caddyfile", "deploy/platform/preflight.mjs"])
    assert.equal(classifyChangedFiles([path]).jobs.production_bundle, true);
  const workflow = load(read(".github/workflows/ci.yml"));
  const steps = workflow.jobs["production-bundle"].steps;
  assert.ok(
    workflow.jobs["platform-contracts"].steps.some((s) =>
      s.run?.includes("deploy/platform/test/*.test.mjs"),
    ),
  );
  assert.ok(steps.some((s) => s.with?.file === "deploy/platform/edge.Dockerfile"));
  assert.ok(steps.some((s) => s.run?.includes("node deploy/platform/ci-stack.mjs")));
  // The platform release re-runs these contracts and builds the platform edge;
  // the retired Yandex release and deploy workflows are gone (2026-10-21).
  const release = read(".github/workflows/release-platform-images.yml");
  assert.match(release, /node --test deploy\/platform\/test\/\*\.test\.mjs/u);
  assert.match(release, /--file deploy\/platform\/edge\.Dockerfile/u);
  for (const retired of ["release-images.yml", "deploy-production.yml"])
    assert.throws(() => read(`.github/workflows/${retired}`), /ENOENT/u, retired);
});

test("edge entrypoint rejects multiline Caddy injection without relying on preflight", async () => {
  const { spawnSync } = await import("node:child_process");
  const directory = await mkdtemp(join(tmpdir(), "platform-entrypoint-"));
  try {
    const binary = join(directory, "caddy");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const valid = { ...env(), MARKIRO_RELEASE_SHA: sha, PATH: `${directory}:${process.env.PATH}` };
    const run = (patch) =>
      spawnSync("sh", ["deploy/platform/edge-entrypoint.sh"], {
        env: { ...valid, ...patch },
        encoding: "utf8",
      });
    assert.equal(run({}).status, 0);
    for (const key of [
      "MARKIRO_RELEASE_SHA",
      "MARKIRO_SAAS_ADMIN_DOMAIN",
      "MARKIRO_LANDING_DOMAIN",
      "MARKIRO_RETIRED_ADMIN_DOMAIN",
      "MARKIRO_RETIRED_KIOSK_DOMAIN",
      "MARKIRO_RELEASES_DOMAIN",
      "MARKIRO_RELEASES_BUCKET",
      "S3_PUBLIC_ORIGIN",
      "ACME_EMAIL",
    ]) {
      for (const suffix of ["\nmalicious", "\rmalicious", "\tmalicious", " malicious"]) {
        const result = run({ [key]: valid[key] + suffix });
        assert.equal(result.status, 64, key);
        assert.doesNotMatch(result.stderr, /malicious/);
      }
    }
    for (const patch of [
      { SERVER_PROFILE: "legacy" },
      { VITE_SERVER_PROFILE: "" },
      { MARKIRO_RETIRED_ADMIN_DOMAIN: valid.MARKIRO_LANDING_DOMAIN },
      { MARKIRO_RELEASES_DOMAIN: valid.MARKIRO_LANDING_DOMAIN },
      { MARKIRO_RELEASES_DOMAIN: "" },
      { MARKIRO_RELEASES_BUCKET: "" },
      { MARKIRO_RELEASES_BUCKET: "a/b" },
      { MARKIRO_RELEASES_BUCKET: "Releases" },
    ])
      assert.equal(run(patch).status, 64);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("optional support import requires explicit protected Chatwoot configuration", () => {
  assert.throws(() => validateConfig({ ...env(), SUPPORT_CHAT_ENABLED: "true" }, manifest()));
  assert.doesNotThrow(() =>
    validateConfig(
      {
        ...env(),
        SUPPORT_CHAT_ENABLED: "true",
        SUPPORT_CHATWOOT_BASE_URL: "https://support.example.org",
        SUPPORT_CHATWOOT_ACCOUNT_ID: "1",
        SUPPORT_CHATWOOT_INBOX_ID: "2",
        SUPPORT_CHATWOOT_API_TOKEN: "test-token",
      },
      manifest(),
    ),
  );
  assert.equal(
    load(read("deploy/platform/compose.yml")).services.api.environment.SUPPORT_CHAT_ENABLED,
    undefined,
  );
});

test("optional lead Telegram alerts need a well-formed token and chat only when enabled", () => {
  const token = "42:not-a-real-telegram-bot-token";
  assert.doesNotThrow(() => validateConfig(env(), manifest()));
  assert.doesNotThrow(() =>
    validateConfig({ ...env(), LEAD_TELEGRAM_ENABLED: "false" }, manifest()),
  );
  for (const patch of [
    { LEAD_TELEGRAM_ENABLED: "yes" },
    { LEAD_TELEGRAM_ENABLED: "true" },
    { LEAD_TELEGRAM_ENABLED: "true", LEAD_TELEGRAM_BOT_TOKEN: token },
    { LEAD_TELEGRAM_ENABLED: "true", LEAD_TELEGRAM_CHAT_ID: "-1001234567890" },
    {
      LEAD_TELEGRAM_ENABLED: "true",
      LEAD_TELEGRAM_BOT_TOKEN: "not-a-token",
      LEAD_TELEGRAM_CHAT_ID: "-1001234567890",
    },
    {
      LEAD_TELEGRAM_ENABLED: "true",
      LEAD_TELEGRAM_BOT_TOKEN: token,
      LEAD_TELEGRAM_CHAT_ID: "chat",
    },
  ])
    assert.throws(() => validateConfig({ ...env(), ...patch }, manifest()));
  for (const chat of ["-1001234567890", "42", "@markiro_leads"])
    assert.doesNotThrow(() =>
      validateConfig(
        {
          ...env(),
          LEAD_TELEGRAM_ENABLED: "true",
          LEAD_TELEGRAM_BOT_TOKEN: token,
          LEAD_TELEGRAM_CHAT_ID: chat,
        },
        manifest(),
      ),
    );
  for (const months of ["1", "12", "60"])
    assert.doesNotThrow(() =>
      validateConfig({ ...env(), LEAD_RETENTION_MONTHS: months }, manifest()),
    );
  for (const months of ["", "0", "61", "1.5", "abc"])
    assert.throws(() => validateConfig({ ...env(), LEAD_RETENTION_MONTHS: months }, manifest()));
  // The token is a literal in the protected env file, never a Compose value.
  assert.equal(
    load(read("deploy/platform/compose.yml")).services.api.environment.LEAD_TELEGRAM_BOT_TOKEN,
    undefined,
  );
});

test("optional standalone release storage comes as a set on the CSP's upload origin", () => {
  assert.equal(RELEASES_UPLOAD_ORIGIN, "https://s3.twcstorage.ru");
  const releases = {
    RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru",
    RELEASES_S3_REGION: "ru-1",
    RELEASES_S3_BUCKET: "markiro-releases",
    RELEASES_S3_ACCESS_KEY_ID: "test-releases-access",
    RELEASES_S3_SECRET_ACCESS_KEY: "test-releases-secret",
  };
  assert.doesNotThrow(() => validateConfig(env(), manifest()));
  assert.doesNotThrow(() => validateConfig({ ...env(), ...releases }, manifest()));
  assert.doesNotThrow(() =>
    validateConfig(
      { ...env(), ...releases, RELEASES_PUBLIC_ORIGIN: "https://releases.markiro.app" },
      manifest(),
    ),
  );
  for (const patch of [
    { RELEASES_S3_SECRET_ACCESS_KEY: undefined },
    { RELEASES_S3_REGION: "" },
    { RELEASES_S3_ENDPOINT: "https://storage.yandexcloud.net" },
    { RELEASES_S3_ENDPOINT: "https://s3.twcstorage.ru/" },
    { RELEASES_S3_BUCKET: "Releases" },
    // Never the private bucket, and only the bucket the release host serves.
    { RELEASES_S3_BUCKET: "markiro-private" },
    { RELEASES_S3_BUCKET: "markiro-other-releases" },
    { RELEASES_PUBLIC_ORIGIN: "http://releases.markiro.app" },
    { RELEASES_PUBLIC_ORIGIN: "https://releases.markiro.app/standalone" },
    { RELEASES_PUBLIC_ORIGIN: "https://downloads.markiro.app" },
    { MARKIRO_RELEASES_DOMAIN: "downloads.markiro.app" },
  ]) {
    const config = { ...env(), ...releases, ...patch };
    for (const [key, value] of Object.entries(patch)) if (value === undefined) delete config[key];
    assert.throws(
      () => validateConfig(config, manifest()),
      (error) => !String(error).includes("test-releases-secret"),
      JSON.stringify(patch),
    );
  }
  // The admin may PUT to exactly that origin; the retired hosts may not.
  const caddy = read("deploy/platform/Caddyfile");
  const csp = (name) =>
    caddy.match(new RegExp(`\\(${name}\\)\\s*\\{[\\s\\S]*?Content-Security-Policy "([^"]+)"`))?.[1];
  const connect = (policy) =>
    policy
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("connect-src"));
  assert.equal(connect(csp("saas_admin_csp")), `connect-src 'self' ${RELEASES_UPLOAD_ORIGIN}`);
  assert.equal(connect(csp("application_csp")), "connect-src 'self'");
  assert.equal(
    csp("saas_admin_csp")?.replace(` ${RELEASES_UPLOAD_ORIGIN}`, ""),
    csp("application_csp"),
  );
  const admin = caddy.slice(caddy.indexOf("https://{$MARKIRO_SAAS_ADMIN_DOMAIN}:8443"));
  assert.match(admin.slice(0, admin.indexOf("\n}")), /import saas_admin_csp/);
  assert.equal(caddy.match(/import saas_admin_csp/g)?.length, 1);
});

test("the release host is a read-only, deny-by-default window onto the pinned catalog", () => {
  const caddy = read("deploy/platform/Caddyfile");
  const block = (start) => {
    const from = caddy.indexOf(start);
    assert.notEqual(from, -1, start);
    return caddy.slice(from, caddy.indexOf("\n}\n", from) + 2);
  };
  const upstream = block("(releases_upstream) {");
  const routes = block("(releases_routes) {");
  assert.match(upstream, /rewrite \* \/internal\/release-catalog\{path\}\?/u);
  assert.equal(upstream.match(/reverse_proxy (\S+) \{/u)?.[1], "api:3000");
  for (const header of ["Authorization", "Cookie", "Origin"])
    assert.ok(upstream.includes(`header_up -${header}`));
  assert.match(upstream, /header_down -X-Amz-\*/u);
  assert.match(upstream, /header_down -Access-Control-\*/u);
  assert.doesNotMatch(upstream, /\?Cache-Control|MARKIRO_RELEASES_BUCKET|https:\/\/s3/u);
  assert.match(upstream, /status 403 404[\s\S]*?Cache-Control no-store\s+respond 404/u);
  assert.match(upstream, /status 5xx[\s\S]*?Cache-Control no-store\s+respond 503/u);

  const matcher = (name) => {
    const body = routes.match(new RegExp(`@${name} \\{([\\s\\S]*?)\\n\\t\\t\\}`, "u"))?.[1];
    assert.ok(body, name);
    assert.match(body, /^\s*method GET HEAD$/mu, name);
    return new RegExp(
      body.match(/vars_regexp \{http\.request\.orig_uri\} (\S+)/u)?.[1] ?? "^$",
      "u",
    );
  };
  const immutable = matcher("releaseImmutable");
  const pointer = matcher("releasePointer");
  for (const path of [
    "/station/beta/releases/2.1.0-beta.1/markiro-station-2.1.0-beta.1-windows-x86_64-setup.exe",
    "/station/stable/releases/2.1.0/markiro-station-2.1.0-windows-x86_64.nsis.zip.sig",
    "/station/stable/releases/2.1.0/SHA256SUMS",
    "/signer/stable/releases/1.0.0/markiro-signer-1.0.0-windows-x86_64-setup.exe",
    "/handheld/stable/releases/1.1.1/markiro-tsd-1.1.1.apk",
    "/handheld/beta/releases/1.2.0-beta.1/manifest.json",
    "/standalone/stable/1.2.3/markiro-standalone-1.2.3-windows-x86_64-setup.exe",
    "/standalone/beta/1.3.0/markiro-standalone-1.3.0.update.jws",
  ])
    assert.match(path, immutable, path);
  for (const path of [
    "/station/beta/latest.json",
    "/station/stable/latest.json",
    "/station/download",
    "/station/beta/download",
    "/signer/stable/latest.json",
    "/signer/download",
    "/handheld/stable/latest.json",
    "/handheld/download",
    "/handheld/beta/download",
    "/standalone/stable/latest.json",
    "/standalone/beta/latest.json",
  ])
    assert.match(path, pointer, path);
  for (const path of [
    "/",
    "/station/",
    "/station/beta/",
    "/station/beta/releases/",
    "/station/beta/releases/2.1.0",
    "/station/nightly/latest.json",
    "/station/beta/releases/2.1.0/sub/file",
    "/station/beta/releases/.hidden/x",
    "/signer/beta/latest.json",
    "/standalone/stable/latest.json/x",
    "/media/tenant/file.png",
    "/STATION/download",
  ]) {
    assert.doesNotMatch(path, immutable, path);
    assert.doesNotMatch(path, pointer, path);
  }
  assert.equal(routes.match(/import releases_upstream/gu)?.length, 2);
  // CORS for the landing's download page only, on GET only; everything else 404.
  assert.match(
    routes,
    /@releaseLanding method GET\n\t\theader @releaseLanding \{\n\t\t\tdefer\n\t\t\tAccess-Control-Allow-Origin "https:\/\/\{\$MARKIRO_LANDING_DOMAIN\}"\n/u,
  );
  assert.equal(caddy.match(/Access-Control-Allow-Origin/gu)?.length, 1);
  assert.match(routes, /\n\t\theader Cache-Control no-store\n\t\trespond 404\n\t\}\n\}$/u);
  assert.match(
    caddy,
    /https:\/\/\{\$MARKIRO_RELEASES_DOMAIN\}:8443 \{\n\timport releases_headers\n\timport releases_routes\n\thandle_errors \{[\s\S]*?respond 503[\s\S]*?\n\}/u,
  );
  const plain = block("http://{$MARKIRO_RELEASES_DOMAIN}:8080 {");
  assert.match(plain, /redir @safe https:\/\/\{\$MARKIRO_RELEASES_DOMAIN\}\{uri\} 308/u);
  assert.doesNotMatch(plain, /reverse_proxy/u);
  const edge = load(read("deploy/platform/compose.yml")).services.edge.environment;
  for (const key of ["MARKIRO_RELEASES_DOMAIN", "MARKIRO_RELEASES_BUCKET"])
    assert.equal(edge[key], `\${${key}:?${key} is required}`);
  // The edge reads anonymously and never receives a bucket key.
  assert.doesNotMatch(JSON.stringify(edge), /ACCESS_KEY|SECRET/u);
});

test("the release host serves every path the handheld updater and publisher use", async () => {
  const { handheldArtifactUrl, HANDHELD_PUBLIC_BASE_URL } =
    await import("../../../tools/handheld-release/manifest.mjs");
  const { handheldDownloadKey, handheldManifestKey, handheldObjectKey } =
    await import("../../../tools/handheld-release/object-storage.mjs");
  const caddy = read("deploy/platform/Caddyfile");
  const pattern = (name) =>
    new RegExp(
      caddy.match(
        new RegExp(`@${name} \\{[\\s\\S]*?vars_regexp \\{http\\.request\\.orig_uri\\} (\\S+)`, "u"),
      )?.[1] ?? "^$",
      "u",
    );
  const served = (path) =>
    pattern("releaseImmutable").test(path) || pattern("releasePointer").test(path);
  // The terminal polls this channel and installs exactly this artifact URL.
  const kotlin = read(
    "apps/handheld/app/src/main/kotlin/app/markiro/handheld/core/update/UpdateCheck.kt",
  );
  const base = kotlin.match(/const val UPDATE_CHANNEL_BASE_URL = "([^"]+)"/u)?.[1];
  assert.equal(base, "https://releases.markiro.app/handheld/stable");
  assert.equal(new URL(HANDHELD_PUBLIC_BASE_URL).hostname, "releases.markiro.app");
  for (const versionName of ["1.7.0", "1.6.2"]) {
    const apk = new URL(`${base}/releases/${versionName}/markiro-tsd-${versionName}.apk`);
    assert.equal(apk.href, handheldArtifactUrl({ channel: "stable", versionName }));
    assert.ok(served(apk.pathname), apk.pathname);
  }
  assert.ok(served(new URL(`${base}/latest.json`).pathname));
  for (const channel of ["stable", "beta"]) {
    for (const key of [
      handheldManifestKey(channel),
      handheldDownloadKey(channel),
      handheldObjectKey({ channel, versionName: "1.7.0", filename: "markiro-tsd-1.7.0.apk" }),
      handheldObjectKey({ channel, versionName: "1.7.0", filename: "manifest.json" }),
    ])
      assert.ok(served(`/${key}`), key);
  }
});

test("S3 CSP origin matches the runtime presigner addressing mode", () => {
  assert.throws(() =>
    validateConfig({ ...env(), S3_PUBLIC_ORIGIN: "https://different.example.org" }, manifest()),
  );
  assert.doesNotThrow(() =>
    validateConfig(
      {
        ...env(),
        S3_FORCE_PATH_STYLE: "false",
        S3_PUBLIC_ORIGIN: "https://markiro-private.s3.example.org",
      },
      manifest(),
    ),
  );
  assert.throws(() => validateConfig({ ...env(), S3_FORCE_PATH_STYLE: "false" }, manifest()));
});

test("PostgreSQL TLS mode cannot be overridden by repeated query parameters", () => {
  for (const mode of ["disable", "no-verify"]) {
    assert.throws(() =>
      validateConfig(
        { ...env(), DATABASE_URL: `${env().DATABASE_URL}&sslmode=${mode}` },
        manifest(),
      ),
    );
  }
});

test("raw protected env preserves literal PEM separators and separate public keyset JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "platform-pem-contract-"));
  const path = join(directory, "runtime.env");
  const pem = String.raw`-----BEGIN PRIVATE KEY-----\nTEST-ONLY-PLACEHOLDER\n-----END PRIVATE KEY-----`;
  const keyset = '{"keys":[{"kty":"OKP","crv":"Ed25519","kid":"test-only","x":"placeholder"}]}';
  try {
    await writeFile(
      path,
      `STANDALONE_LICENSE_PRIVATE_KEY_PEM=${pem}\nSTANDALONE_LICENSE_KEYSET_JSON=${keyset}\n`,
      { mode: 0o600 },
    );
    const parsed = await readProtectedEnv(path);
    assert.equal(parsed.STANDALONE_LICENSE_PRIVATE_KEY_PEM, pem);
    assert.equal(parsed.STANDALONE_LICENSE_KEYSET_JSON, keyset);
    assert.equal(parsed.STANDALONE_LICENSE_PRIVATE_KEY_PEM.split(String.raw`\n`).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CI PostgreSQL health waits for final TCP listener instead of the socket-only init server", () => {
  const schema = new Schema([
    ...CORE_SCHEMA.tags,
    defineSequenceTag("!override", {
      create: () => [],
      addItem: (items, item) => {
        items.push(item);
      },
      identify: () => false,
    }),
  ]);
  const compose = load(read("deploy/platform/compose.ci.yml"), { schema });
  assert.deepEqual(compose.services.postgres.healthcheck.test, [
    "CMD",
    "pg_isready",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "markiro",
  ]);
});
