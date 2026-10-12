import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";

const envModule = new URL("../api-validation-env.mjs", import.meta.url).href;
const runnerModule = new URL("../run-api-validation.mjs", import.meta.url).href;

test("parent PostgreSQL driver cannot inherit SSL or server options", () => {
  const script = `
    const guard = await import(${JSON.stringify(envModule)});
    const clean = {...(guard.cleanRuntimeEnv ?? ((env) => env))(process.env)};
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, clean);
    const {createRequire} = await import('node:module');
    const require = createRequire(new URL('../../../packages/db/package.json', ${JSON.stringify(import.meta.url)}));
    const {Client} = require('pg');
    const parameters = new Client({ connectionString: 'postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev' }).connectionParameters;
    console.log(JSON.stringify({ssl: parameters.ssl, options: parameters.options, sslnegotiation: parameters.sslnegotiation}));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PGOPTIONS: "-c default_transaction_read_only=on",
      PGSSLMODE: "require",
      PGSSLNEGOTIATION: "direct",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const parameters = JSON.parse(result.stdout);
  assert.equal(parameters.ssl, false);
  assert.ok(!parameters.options);
  assert.notEqual(parameters.sslnegotiation, "direct");
});

for (const phase of ["create", "migrate", "drop"]) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`defers ${signal} during owned ${phase} until awaited cleanup`, async () => {
      const script = `
        const runner = await import(${JSON.stringify(runnerModule)});
        const withSignals = runner.withDeferredSignals ?? (async (operation) => operation({stopping: false}));
        const rendezvous = async () => {
          process.send('ready');
          await new Promise((resolve) => process.once('message', resolve));
        };
        process.exitCode = await withSignals(async () => {
          try {
            if (${JSON.stringify(phase)} !== 'drop') await rendezvous();
          } finally {
            if (${JSON.stringify(phase)} === 'drop') await rendezvous();
            console.log('owned cleanup completed');
          }
          return 0;
        });
        process.disconnect();
      `;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: { PATH: process.env.PATH },
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.on("message", () => {
        child.kill(signal);
        setTimeout(() => {
          if (child.connected) child.send("continue", () => {});
        }, 30);
      });
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, killedBy) => resolve({ code, killedBy }));
      });
      assert.match(output, /owned cleanup completed/);
      assert.deepEqual(result, { code: signal === "SIGINT" ? 130 : 143, killedBy: null });
    });
  }
}

// A missing guard is itself a failure: none of the unsafe inputs may reach PostgreSQL.
const guard = await import("../api-validation-env.mjs").catch(() => ({}));
const base = "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev";
const name = "markiro_us_api_12345678_1234_4234_8234_123456789abc";
const secrets = {
  auth: "a".repeat(64),
  platform: "b".repeat(64),
  pepper: "c".repeat(64),
  chz: Buffer.alloc(32, 1).toString("base64"),
  mail: Buffer.alloc(32, 2).toString("base64"),
};
const services = { port: 49152 };

test("rejects remote, shared, malformed and option-bearing administrative URLs without disclosure", () => {
  assert.equal(typeof guard.validateBaseUrl, "function");
  for (const raw of [
    "private-secret",
    base.replace("127.0.0.1", "remote.example"),
    base.replace("55432", "5432"),
    base.replace("markiro_us_dev", "markiro"),
    base.replace("markiro_us:", "markiro:"),
    `${base}?options=private-secret`,
    `${base}#private-secret`,
    ` ${base}`,
    base.replace("127.0.0.1", "localhost"),
  ]) {
    assert.throws(
      () => guard.validateBaseUrl(raw),
      (error) => !error.message.includes("private-secret") && !error.message.includes("synthetic"),
    );
  }
  assert.equal(guard.validateBaseUrl(base).hostname, "127.0.0.1");
});

test("child environment excludes inherited secrets, preloads, DB overrides and operational endpoints", () => {
  assert.equal(typeof guard.createValidationEnv, "function");
  const env = guard.createValidationEnv(
    base,
    name,
    secrets,
    {
      PATH: "/usr/bin",
      HOME: "/synthetic-home",
      DATABASE_URL: "production-secret",
      US_TEST_DATABASE_URL: "production-secret",
      NODE_OPTIONS: "--import malicious",
      PGHOST: "remote",
      S3_ENDPOINT: "https://remote",
      SMTP_HOST: "remote",
      BETTER_AUTH_SECRET: "production-secret",
    },
    services,
  );
  assert.equal(env.DATABASE_URL, `postgres://markiro_us:synthetic@127.0.0.1:55432/${name}`);
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.BETTER_AUTH_URL, "http://localhost:3000");
  assert.equal(env.ADMIN_ORIGIN, "http://localhost:5173");
  assert.equal(env.SAAS_ADMIN_ORIGIN, "http://localhost:5473");
  assert.equal(env.KIOSK_ORIGIN, "http://localhost:5373");
  assert.equal(env.BETTER_AUTH_SECRET, secrets.auth);
  assert.equal(env.PLATFORM_AUTH_SECRET, secrets.platform);
  for (const key of [
    "US_TEST_DATABASE_URL",
    "NODE_OPTIONS",
    "PGHOST",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ])
    assert.equal(env[key], undefined);
  assert.ok(!JSON.stringify(env).includes("production-secret"));
  for (const unsafe of [
    "markiro_us_dev",
    "markiro_us_api_shared",
    `${name}"; DROP DATABASE postgres;--`,
  ])
    assert.throws(() => guard.createValidationEnv(base, unsafe, secrets, {}));
});

test("routes mail and storage defaults only to invocation-reserved loopback ports", () => {
  const env = guard.createValidationEnv(base, name, secrets, {}, services);
  assert.equal(env.SMTP_HOST, "127.0.0.1");
  assert.equal(env.SMTP_PORT, "49152");
  assert.equal(env.SMTP_SECURE, "false");
  assert.equal(env.S3_ENDPOINT, "http://127.0.0.1:49152");
  for (const unsafe of [
    undefined,
    { port: 0 },
    { port: 1025 },
    { port: 9000 },
    { port: "49152" },
    { port: 65536 },
  ])
    assert.throws(() => guard.createValidationEnv(base, name, secrets, {}, unsafe));
});

test("only fixed remaining and full modes can select tests, with no extra flags", () => {
  assert.equal(typeof guard.validationArgs, "function");
  for (const args of [
    [],
    ["repair"],
    ["remaining", "--testTimeout=900000"],
    ["full", "--exclude=fail"],
  ])
    assert.throws(() => guard.validationArgs(args));
  const remaining = guard.validationArgs(["remaining"]);
  assert.deepEqual(remaining, [
    "run",
    ...[
      "billing-accounts.e2e",
      "exchange-credentials.e2e",
      "exchange-import.e2e",
      "exchange-orders.e2e",
      "exchange-protocol.e2e",
      "integrations-delete.e2e",
      "integrations.e2e",
      "subscription-route-inventory",
    ].map((file) => `test/${file}.test.ts`),
  ]);
  assert.deepEqual(guard.validationArgs(["full"]), ["run"]);
});
