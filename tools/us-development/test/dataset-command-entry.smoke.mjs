import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import test from "node:test";

const arguments_ = [
  "verify",
  "--database-name",
  "markiro_us_dev",
  "--database-user",
  "markiro_us",
  "--tenant-id",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "--owner-id",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "--version",
  "us-processor-six-month-v1",
  "--definition-digest",
  "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
];
const storage = {
  US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
  US_PLAN_ARTIFACT_S3_BUCKET: "synthetic-dataset-plans",
  US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-plan-access",
  US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-plan-secret",
  US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
  US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_REQUEST_PACKAGE_S3_REGION: "us-east-1",
  US_REQUEST_PACKAGE_S3_BUCKET: "synthetic-dataset-packages",
  US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID: "synthetic-package-access",
  US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "synthetic-package-secret",
  US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE: "true",
};

test("compiled dataset command refuses unsafe inputs/builds with no connection/listener/private output", () => {
  const descriptor = "apps/api/dist/us-request-build.json";
  const saved = readFileSync(descriptor);
  const document = JSON.parse(saved);
  const directory = mkdtempSync(join(tmpdir(), "us-dataset-entry-"));
  const guard = join(directory, "guard.cjs");
  const opened = join(directory, "external-io-opened");
  writeFileSync(
    guard,
    `
    const net = require('node:net');
    const fail = () => { require('node:fs').writeFileSync(${JSON.stringify(opened)}, 'opened'); throw new Error('forbidden external IO raw-secret'); };
    net.Server.prototype.listen = fail;
    net.Socket.prototype.connect = fail;
  `,
  );
  const environment = {
    ...parseEnv(readFileSync("deploy/us-development/local.env.example", "utf8")),
    ...storage,
  };
  const cases = [
    { args: [], code: "us_dataset_command_arguments_invalid" },
    { args: [...arguments_, "--reset=raw-secret"], code: "us_dataset_command_arguments_invalid" },
    { override: { NODE_ENV: "production" }, code: "us_dataset_command_environment_invalid" },
    {
      override: { MARKIRO_DEPLOYMENT_EDITION: "RU" },
      code: "us_dataset_command_environment_invalid",
    },
    {
      override: {
        DATABASE_URL: "postgres://markiro_us:raw-secret@remote.invalid:55432/markiro_us_dev",
      },
      code: "us_dataset_command_environment_invalid",
    },
    {
      override: { DATABASE_URL: "postgres://wrong:raw-secret@127.0.0.1:55432/markiro_us_dev" },
      code: "us_dataset_command_environment_invalid",
    },
    {
      override: { US_REQUEST_PACKAGE_S3_BUCKET: "" },
      code: "us_dataset_command_storage_unavailable",
    },
    { manifest: null, code: "us_dataset_command_build_invalid" },
    { manifest: "{raw-secret", code: "us_dataset_command_build_invalid" },
    {
      manifest: JSON.stringify({ ...document, build: { ...document.build, dirty: true } }),
      code: "us_dataset_command_build_invalid",
    },
  ];
  try {
    for (const scenario of cases) {
      // Restore only this smoke's owned descriptor fixture between literal cases.
      writeFileSync(descriptor, saved);
      if (scenario.manifest === null) rmSync(descriptor);
      else if (scenario.manifest !== undefined) writeFileSync(descriptor, scenario.manifest);
      const env = { ...environment, ...scenario.override };
      const result = spawnSync(
        process.execPath,
        ["--require", guard, "apps/api/dist/main.us-dataset.js", ...(scenario.args ?? arguments_)],
        { env, encoding: "utf8", timeout: 6000 },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${JSON.stringify({ code: scenario.code })}\n`);
      assert.equal(existsSync(opened), false);
      for (const secret of [
        ...Object.values(env),
        "raw-secret",
        "SELECT ",
        "postgres://",
        "Error:",
        " at ",
      ]) {
        if (secret.length > 8 || ["SELECT ", "Error:", " at "].includes(secret))
          assert.ok(!result.stderr.includes(secret));
      }
    }
  } finally {
    writeFileSync(descriptor, saved);
    assert.deepEqual(readFileSync(descriptor), saved);
    rmSync(directory, { recursive: true, force: true });
  }
});
