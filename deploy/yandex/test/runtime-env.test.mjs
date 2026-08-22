import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  environmentKeysFromExample,
  materializeRuntimeEnv,
  renderRuntimeEnvironment,
  runCli,
  runInventoryCli,
  runtimeInventoryKeyNames,
  verifyRuntimeInventory,
} from "../runtime-env.mjs";

const INVENTORY = `# runtime inventory\nDATABASE_URL=\nSMTP_PASSWORD=\nS3_ENDPOINT=\n`;
const VALUES = {
  DATABASE_URL: "postgres://markiro:password@db.example.test/markiro",
  SMTP_PASSWORD: "mail-password",
  S3_ENDPOINT: "https://storage.example.test",
};

const INVENTORY_FAILURE = "runtime environment inventory is invalid";

function response(payload, ok = true) {
  return { ok, json: async () => payload };
}

function fakeFilesystem(files = new Map()) {
  const operations = [];
  return {
    files,
    operations,
    async mkdir(path, options) {
      operations.push(["mkdir", path, options]);
    },
    async open(path, flags, mode) {
      operations.push(["open", path, flags, mode]);
      files.set(path, { text: "", mode });
      return {
        async writeFile(text) {
          operations.push(["writeFile", path, text]);
          files.get(path).text = text;
        },
        async sync() {
          operations.push(["fsync", path]);
        },
        async close() {
          operations.push(["close", path]);
        },
      };
    },
    async chmod(path, mode) {
      operations.push(["chmod", path, mode]);
      files.get(path).mode = mode;
    },
    async rename(from, to) {
      operations.push(["rename", from, to]);
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(path) {
      operations.push(["unlink", path]);
      files.delete(path);
    },
    async openDirectory(path) {
      operations.push(["openDirectory", path]);
      return {
        async sync() {
          operations.push(["fsyncDirectory", path]);
        },
        async close() {
          operations.push(["closeDirectory", path]);
        },
      };
    },
  };
}

test("materializes the exact inventory atomically with a private destination", async () => {
  const fs = fakeFilesystem();
  await materializeRuntimeEnv({
    destination: "/etc/markiro/production.env",
    fs,
    inventoryText: INVENTORY,
    secretId: "runtime-secret-id",
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () =>
      Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    mode: 0o600,
    text:
      "DATABASE_URL=postgres://markiro:password@db.example.test/markiro\n" +
      "S3_ENDPOINT=https://storage.example.test\n" +
      "SMTP_PASSWORD=mail-password\n",
  });
  assert.deepEqual(
    fs.operations.map(([operation]) => operation),
    [
      "mkdir",
      "open",
      "writeFile",
      "fsync",
      "close",
      "chmod",
      "rename",
      "openDirectory",
      "fsyncDirectory",
      "closeDirectory",
    ],
  );
  assert.equal(
    fs.operations.find(([operation]) => operation === "open")[1],
    "/etc/markiro/.production.env.runtime.tmp",
  );
});

test("rejects missing, duplicate, unknown, and newline lockbox entries", () => {
  assert.throws(
    () =>
      renderRuntimeEnvironment(environmentKeysFromExample(INVENTORY), [
        { key: "DATABASE_URL", textValue: "value" },
      ]),
    /runtime environment payload is invalid/,
  );
  assert.throws(
    () =>
      renderRuntimeEnvironment(environmentKeysFromExample(INVENTORY), [
        ...Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
        { key: "SMTP_PASSWORD", textValue: "repeated" },
      ]),
    /runtime environment payload is invalid/,
  );
  assert.throws(
    () =>
      renderRuntimeEnvironment(environmentKeysFromExample(INVENTORY), [
        ...Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
        { key: "UNEXPECTED", textValue: "value" },
      ]),
    /runtime environment payload is invalid/,
  );
  assert.throws(
    () =>
      renderRuntimeEnvironment(environmentKeysFromExample(INVENTORY), [
        ...Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
        { key: "SMTP_PASSWORD", textValue: "line one\nline two" },
      ]),
    /runtime environment payload is invalid/,
  );
});

test("rejects duplicate and malformed environment inventory keys", () => {
  assert.throws(
    () => environmentKeysFromExample("DATABASE_URL=\nDATABASE_URL=\n"),
    /runtime environment inventory is invalid/,
  );
  assert.throws(
    () => environmentKeysFromExample("DATABASE_URL=value\n"),
    /runtime environment inventory is invalid/,
  );
  assert.deepEqual(
    environmentKeysFromExample("  # comment\n\t\nDATABASE_URL=\n\nSMTP_PASSWORD=\n"),
    ["DATABASE_URL", "SMTP_PASSWORD"],
  );
});

test("runtime inventory returns only sorted exact key names", () => {
  const keys = environmentKeysFromExample(INVENTORY);
  const entries = Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));

  const result = runtimeInventoryKeyNames(keys, entries);

  assert.deepEqual(result, ["DATABASE_URL", "S3_ENDPOINT", "SMTP_PASSWORD"]);
  assert.doesNotMatch(JSON.stringify(result), /password|storage\.example|postgres:/u);
});

test("runtime inventory rejects missing, extra, duplicate, malformed, and valueless entries uniformly", () => {
  const keys = environmentKeysFromExample(INVENTORY);
  const entries = Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));
  const invalidCases = [
    { keys: keys.slice(0, -1), entries },
    { keys: [...keys, "UNEXPECTED"], entries },
    { keys: [...keys, keys[0]], entries },
    { keys: [...keys, "bad-key"], entries },
    { keys, entries: entries.slice(0, -1) },
    { keys, entries: [...entries, { key: "UNEXPECTED", textValue: "private" }] },
    { keys, entries: [...entries, entries[0]] },
    {
      keys,
      entries: entries.map((entry, index) => (index === 0 ? { ...entry, key: "bad-key" } : entry)),
    },
    {
      keys,
      entries: entries.map((entry, index) =>
        index === 0 ? { key: entry.key, textValue: undefined } : entry,
      ),
    },
    { keys, entries: entries.map((entry, index) => (index === 0 ? null : entry)) },
    { keys: [], entries: [] },
  ];

  for (const invalid of invalidCases)
    assert.throws(
      () => runtimeInventoryKeyNames(invalid.keys, invalid.entries),
      (error) => error.message === INVENTORY_FAILURE,
    );
});

test("inventory verifier fetches metadata and Lockbox once without exposing payload values", async () => {
  const calls = [];
  const result = await verifyRuntimeInventory({
    inventoryText: INVENTORY,
    secretId: "runtime-secret-id",
    fetchIamToken: async () => {
      calls.push("metadata");
      return "iam-token";
    },
    fetchSecretPayload: async (secretId, token) => {
      calls.push(["lockbox", secretId, token]);
      return Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue }));
    },
  });

  assert.deepEqual(result, ["DATABASE_URL", "S3_ENDPOINT", "SMTP_PASSWORD"]);
  assert.deepEqual(calls, ["metadata", ["lockbox", "runtime-secret-id", "iam-token"]]);
  assert.doesNotMatch(JSON.stringify(result), /mail-password|storage\.example|postgres:/u);
});

test("inventory verifier maps dependency and payload details to one fixed error", async () => {
  const secretValue = "private-runtime-value";
  await assert.rejects(
    verifyRuntimeInventory({
      inventoryText: INVENTORY,
      secretId: "runtime-secret-id",
      fetchIamToken: async () => "iam-token",
      fetchSecretPayload: async () => {
        throw new Error(secretValue);
      },
    }),
    (error) => {
      assert.equal(error.message, INVENTORY_FAILURE);
      assert.doesNotMatch(error.message, new RegExp(secretValue));
      return true;
    },
  );
});

test("inventory CLI reads only the absolute candidate inventory before read-only verification", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "markiro candidate inventory "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inventoryPath = join(directory, ".env.production.example");
  await copyFile(resolve(".env.production.example"), inventoryPath);
  const inventory = environmentKeysFromExample(await readFile(inventoryPath, "utf8"));
  const calls = [];
  const stderr = [];
  const stdout = [];

  const exitCode = await runInventoryCli({
    environment: { MARKIRO_RUNTIME_SECRET_ID: "runtime-secret-id" },
    inventoryPath,
    readInventory: async (candidatePath, encoding) => {
      calls.push(["read", candidatePath, encoding]);
      return readFile(candidatePath, encoding);
    },
    fetchIamToken: async () => {
      calls.push("metadata");
      return "iam-token";
    },
    fetchSecretPayload: async () => {
      calls.push("lockbox");
      return inventory.map((key) => ({ key, textValue: `private-${key}` }));
    },
    stderr: { write: (line) => stderr.push(line) },
    stdout: { write: (line) => stdout.push(line) },
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderr, []);
  assert.deepEqual(stdout, []);
  assert.deepEqual(calls, [["read", inventoryPath, "utf8"], "metadata", "lockbox"]);
});

test("inventory CLI rejects invalid argv and non-absolute paths before network access", async () => {
  for (const argv of [
    ["verify-inventory"],
    ["verify-inventory", "relative.env"],
    ["verify-inventory", "/candidate/.env.production.example", "extra"],
    ["unknown", "/candidate/.env.production.example"],
  ]) {
    const calls = [];
    const stderr = [];
    const exitCode = await runCli({
      argv,
      environment: { MARKIRO_RUNTIME_SECRET_ID: "runtime-secret-id" },
      fetchIamToken: async () => {
        calls.push("metadata");
        return "iam-token";
      },
      fetchSecretPayload: async () => {
        calls.push("lockbox");
        return [];
      },
      readInventory: async () => {
        calls.push("read");
        return INVENTORY;
      },
      stderr: { write: (line) => stderr.push(line) },
    });

    assert.equal(exitCode, 1);
    assert.deepEqual(calls, []);
    assert.deepEqual(stderr, [`${INVENTORY_FAILURE}\n`]);
  }
});

test("inventory CLI emits only its fixed failure line and never mutates a destination", async () => {
  const secretValue = "private-lockbox-payload";
  const stderr = [];
  const calls = [];
  const exitCode = await runInventoryCli({
    environment: { MARKIRO_RUNTIME_SECRET_ID: "runtime-secret-id" },
    inventoryPath: "/candidate/.env.production.example",
    readInventory: async () => INVENTORY,
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () => {
      throw new Error(secretValue);
    },
    fs: {
      async rename() {
        calls.push("rename");
      },
      async writeFile() {
        calls.push("writeFile");
      },
    },
    stderr: { write: (line) => stderr.push(line) },
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(stderr, [`${INVENTORY_FAILURE}\n`]);
  assert.doesNotMatch(stderr.join(""), new RegExp(secretValue));
});

test("uses every and only the production environment example keys", async () => {
  const inventoryText = await readFile(".env.production.example", "utf8");
  const inventory = environmentKeysFromExample(inventoryText);
  assert.deepEqual(inventory, [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "BETTER_AUTH_URL",
    "ADMIN_ORIGIN",
    "PLATFORM_AUTH_SECRET",
    "PLATFORM_AUTH_URL",
    "SAAS_ADMIN_ORIGIN",
    "SUBSCRIPTION_ENFORCEMENT_MODE",
    "KIOSK_ORIGIN",
    "STATION_ORIGIN",
    "VITE_STATION_API_URL",
    "PAIRING_CODE_PEPPER",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_SECURE",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM_EMAIL",
    "SMTP_FROM_NAME",
    "SMTP_REPLY_TO",
    "MAIL_PAYLOAD_ENCRYPTION_KEY",
    "LANDING_DEMO_SUBMISSION_ENABLED",
    "LANDING_ORIGIN",
    "LANDING_DEMO_RECIPIENT",
    "LANDING_DEMO_REPLY_TO",
    "SMARTCAPTCHA_SERVER_KEY",
    "LANDING_DEMO_RATE_WINDOW_SECONDS",
    "LANDING_DEMO_SOURCE_LIMIT",
    "LANDING_DEMO_GLOBAL_LIMIT",
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_FORCE_PATH_STYLE",
    "DADATA_TOKEN",
    "DADATA_SECRET",
  ]);
  assert.equal(inventory.length, 37);
  assert.deepEqual(
    runtimeInventoryKeyNames(
      inventory,
      inventory.map((key) => ({ key, textValue: `private-${key}` })),
    ),
    [...inventory].sort(),
  );
});

test("a failed refresh preserves the prior environment and cleans its temporary file", async () => {
  const fs = fakeFilesystem(
    new Map([["/etc/markiro/production.env", { text: "DATABASE_URL=old\n", mode: 0o600 }]]),
  );

  await assert.rejects(
    materializeRuntimeEnv({
      destination: "/etc/markiro/production.env",
      fs,
      inventoryText: INVENTORY,
      secretId: "runtime-secret-id",
      fetchIamToken: async () => "iam-token",
      fetchSecretPayload: async () => [{ key: "DATABASE_URL", textValue: "new" }],
      temporaryName: () => ".production.env.runtime.tmp",
    }),
    /runtime environment materialization failed/,
  );

  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    text: "DATABASE_URL=old\n",
    mode: 0o600,
  });
  assert.equal(fs.files.has("/etc/markiro/.production.env.runtime.tmp"), false);
});

test("a failed atomic write removes its sibling temporary file without replacing the prior environment", async () => {
  const fs = fakeFilesystem(
    new Map([["/etc/markiro/production.env", { text: "DATABASE_URL=old\n", mode: 0o600 }]]),
  );
  const openFile = fs.open;
  fs.open = async (...arguments_) => {
    const file = await openFile(...arguments_);
    return {
      ...file,
      async writeFile() {
        fs.operations.push(["writeFileFailure"]);
        throw new Error("disk write failed");
      },
    };
  };

  await assert.rejects(
    materializeRuntimeEnv({
      destination: "/etc/markiro/production.env",
      fs,
      inventoryText: INVENTORY,
      secretId: "runtime-secret-id",
      fetchIamToken: async () => "iam-token",
      fetchSecretPayload: async () =>
        Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
      temporaryName: () => ".production.env.runtime.tmp",
    }),
    /runtime environment materialization failed/,
  );

  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    text: "DATABASE_URL=old\n",
    mode: 0o600,
  });
  assert.equal(fs.files.has("/etc/markiro/.production.env.runtime.tmp"), false);
  assert.ok(fs.operations.some(([operation]) => operation === "unlink"));
  assert.equal(
    fs.operations.some(([operation]) => operation === "rename"),
    false,
  );
});

test("directory fsync after rename keeps the new environment and reports only a sanitized durability warning", async () => {
  const fs = fakeFilesystem(
    new Map([["/etc/markiro/production.env", { text: "DATABASE_URL=old\n", mode: 0o600 }]]),
  );
  fs.openDirectory = async (path) => ({
    async sync() {
      fs.operations.push(["fsyncDirectoryFailure", path]);
      throw new Error("directory /etc/markiro could not sync");
    },
    async close() {
      fs.operations.push(["closeDirectory", path]);
    },
  });
  const warnings = [];

  await materializeRuntimeEnv({
    destination: "/etc/markiro/production.env",
    fs,
    inventoryText: INVENTORY,
    onWarning: (warning) => warnings.push(warning),
    secretId: "runtime-secret-id",
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () =>
      Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    mode: 0o600,
    text:
      "DATABASE_URL=postgres://markiro:password@db.example.test/markiro\n" +
      "S3_ENDPOINT=https://storage.example.test\n" +
      "SMTP_PASSWORD=mail-password\n",
  });
  assert.deepEqual(warnings, ["runtime environment durability is indeterminate"]);
  assert.doesNotMatch(warnings[0], /\/etc\/markiro/);
  assert.equal(fs.files.has("/etc/markiro/.production.env.runtime.tmp"), false);
});

test("CLI emits one fixed durability warning after a committed rename and keeps success status", async () => {
  const fs = fakeFilesystem();
  fs.openDirectory = async () => ({
    async sync() {
      throw new Error("directory /etc/markiro could not sync");
    },
    async close() {},
  });
  const stderr = [];

  const exitCode = await runCli({
    environment: { MARKIRO_RUNTIME_SECRET_ID: "runtime-secret-id" },
    fs,
    inventoryText: INVENTORY,
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () =>
      Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    stderr: { write: (line) => stderr.push(line) },
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(stderr, ["runtime environment durability is indeterminate\n"]);
  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    mode: 0o600,
    text:
      "DATABASE_URL=postgres://markiro:password@db.example.test/markiro\n" +
      "S3_ENDPOINT=https://storage.example.test\n" +
      "SMTP_PASSWORD=mail-password\n",
  });
});

test("CLI reports a fixed nonzero failure before rename without disclosing secret material", async () => {
  const secretValue = "runtime-secret-value";
  const fs = fakeFilesystem(
    new Map([["/etc/markiro/production.env", { text: "DATABASE_URL=old\n", mode: 0o600 }]]),
  );
  const openFile = fs.open;
  fs.open = async (...arguments_) => {
    const file = await openFile(...arguments_);
    return {
      ...file,
      async writeFile() {
        throw new Error(`write failed: ${secretValue}`);
      },
    };
  };
  const stderr = [];

  const exitCode = await runCli({
    environment: { MARKIRO_RUNTIME_SECRET_ID: secretValue },
    fs,
    inventoryText: INVENTORY,
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () =>
      Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
    stderr: { write: (line) => stderr.push(line) },
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stderr, ["runtime environment materialization failed\n"]);
  assert.doesNotMatch(stderr.join(""), new RegExp(secretValue));
  assert.deepEqual(fs.files.get("/etc/markiro/production.env"), {
    mode: 0o600,
    text: "DATABASE_URL=old\n",
  });
});

test("installed runtime helper resolves its colocated inventory and preserves symlink-safe CLI detection", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "markiro runtime layout "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ["runtime-env.mjs", "cli-main.mjs"]) {
    await copyFile(resolve("deploy/yandex", file), join(directory, file));
  }
  await copyFile(resolve(".env.production.example"), join(directory, ".env.production.example"));

  const installedRuntime = await import(pathToFileURL(join(directory, "runtime-env.mjs")).href);
  const installedCli = await import(pathToFileURL(join(directory, "cli-main.mjs")).href);
  const linkedRuntime = join(directory, "runtime link.mjs");
  await symlink(join(directory, "runtime-env.mjs"), linkedRuntime);
  const fs = fakeFilesystem();
  fs.readFile = readFile;
  const inventory = installedRuntime.environmentKeysFromExample(
    await readFile(join(directory, ".env.production.example"), "utf8"),
  );

  await installedRuntime.materializeRuntimeEnv({
    destination: "/etc/markiro/production.env",
    fs,
    secretId: "runtime-secret-id",
    fetchIamToken: async () => "iam-token",
    fetchSecretPayload: async () => inventory.map((key) => ({ key, textValue: "installed-value" })),
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.match(fs.files.get("/etc/markiro/production.env").text, /^DATABASE_URL=installed-value$/m);
  assert.equal(
    installedCli.isMainModule(pathToFileURL(join(directory, "runtime-env.mjs")).href, [
      process.execPath,
      linkedRuntime,
    ]),
    true,
  );
});

test("materialization diagnostics never reveal Lockbox values, response data, or endpoint credentials", async () => {
  const secretValue = "mail-password-not-for-logs";
  const endpoint = "https://operator:credential@payload.lockbox.example.test/private";
  const rawResponse = `payload=${secretValue}&endpoint=${endpoint}`;

  await assert.rejects(
    materializeRuntimeEnv({
      destination: "/etc/markiro/production.env",
      fs: fakeFilesystem(),
      inventoryText: INVENTORY,
      secretId: "runtime-secret-id",
      fetchIamToken: async () => "iam-token",
      fetchSecretPayload: async () => {
        throw new Error(rawResponse);
      },
    }),
    (error) => {
      assert.match(error.message, /runtime environment materialization failed/);
      for (const forbidden of [secretValue, endpoint, "operator:credential", rawResponse])
        assert.doesNotMatch(
          error.message,
          new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      return true;
    },
  );
});

test("built-in clients request IAM and Lockbox payloads with a bounded signal", async () => {
  const calls = [];
  const timeouts = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1
      ? response({ access_token: "iam-token" })
      : response({
          entries: Object.entries(VALUES).map(([key, textValue]) => ({ key, textValue })),
        });
  };
  await materializeRuntimeEnv({
    destination: "/etc/markiro/production.env",
    fetch,
    fs: fakeFilesystem(),
    inventoryText: INVENTORY,
    clock: {
      timeout: (milliseconds) => {
        timeouts.push(milliseconds);
        return AbortSignal.timeout(milliseconds);
      },
    },
    secretId: "runtime-secret-id",
    temporaryName: () => ".production.env.runtime.tmp",
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(timeouts, [2_000, 2_000]);
  assert.ok(calls.every(({ options }) => options.signal instanceof AbortSignal));
  assert.match(calls[0].url, /^http:\/\/169\.254\.169\.254\//);
  assert.match(calls[1].url, /^https:\/\/payload\.lockbox\.api\.cloud\.yandex\.net\//);
  assert.equal(calls[1].options.headers.authorization, "Bearer iam-token");
});
