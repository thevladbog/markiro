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
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
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

test("CI routes platform files to bundle checks and builds isolated preparation without publishing", () => {
  for (const path of ["deploy/platform/Caddyfile", "deploy/platform/preflight.mjs"])
    assert.equal(classifyChangedFiles([path]).jobs.production_bundle, true);
  const workflow = load(read(".github/workflows/ci.yml"));
  const steps = workflow.jobs["production-bundle"].steps;
  assert.ok(steps.some((s) => s.run?.includes("node --test deploy/platform/test/*.test.mjs")));
  assert.ok(steps.some((s) => s.with?.file === "deploy/platform/edge.Dockerfile"));
  assert.ok(steps.some((s) => s.run?.includes("node deploy/platform/ci-stack.mjs")));
  const release = load(read(".github/workflows/release-images.yml"));
  assert.ok(release.on.push.paths.includes("deploy/platform/**"));
  assert.ok(
    release.jobs["production-bundle"].steps.some(
      (s) => s.run === "env -u COMPOSE_PROJECT_NAME node --test deploy/platform/test/*.test.mjs",
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(release.jobs.publish),
    /markiro-platform-edge|deploy\/platform/u,
  );
  assert.doesNotMatch(
    read(".github/workflows/deploy-production.yml"),
    /markiro-platform-edge|deploy\/platform\/ci-stack/u,
  );
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
