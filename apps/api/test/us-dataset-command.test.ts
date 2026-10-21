import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { datasetCommandEnvironment } from "../src/deployment/us-dataset-command";
import { assertUsPlanArtifactStorageConfig } from "../src/modules/traceability/plans/us-plan-artifact-config";
import { assertUsRequestPackageArtifactStorageConfig } from "../src/modules/traceability/requests/us-request-package-artifact-config";

const initialize = [
  "initialize",
  "--confirm-local-synthetic-dataset",
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
const verify = ["verify", ...initialize.slice(2)];
const plan = {
  US_PLAN_ARTIFACT_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_PLAN_ARTIFACT_S3_REGION: "us-east-1",
  US_PLAN_ARTIFACT_S3_BUCKET: "markiro-us-plans-command-test",
  US_PLAN_ARTIFACT_S3_ACCESS_KEY_ID: "synthetic-command-plan-access",
  US_PLAN_ARTIFACT_S3_SECRET_ACCESS_KEY: "synthetic-command-plan-secret",
  US_PLAN_ARTIFACT_S3_FORCE_PATH_STYLE: "true",
};
const packages = {
  US_REQUEST_PACKAGE_S3_ENDPOINT: "http://127.0.0.1:19000",
  US_REQUEST_PACKAGE_S3_REGION: "us-east-1",
  US_REQUEST_PACKAGE_S3_BUCKET: "markiro-us-packages-command-test",
  US_REQUEST_PACKAGE_S3_ACCESS_KEY_ID: "synthetic-command-package-access",
  US_REQUEST_PACKAGE_S3_SECRET_ACCESS_KEY: "synthetic-command-package-secret",
  US_REQUEST_PACKAGE_S3_FORCE_PATH_STYLE: "true",
};
function environment(): NodeJS.ProcessEnv {
  return {
    ...parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8")),
    ...plan,
    ...packages,
  };
}
function refusal(args: readonly string[], raw: NodeJS.ProcessEnv, code: string): void {
  let caught: unknown;
  try {
    datasetCommandEnvironment(args, raw);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  if (!(caught instanceof Error)) throw new Error("Expected command refusal");
  expect(caught.message).toBe(code);
  expect(caught.cause).toBeUndefined();
  expect(Object.keys(caught)).toEqual([]);
  expect(String(caught)).toBe(`Error: ${code}`);
}
function withArgument(flag: string, value: string): string[] {
  const args = [...initialize];
  args[args.indexOf(flag) + 1] = value;
  return args;
}

describe("six-month dataset command pre-I/O boundary", () => {
  it.each([
    ["initialize", initialize],
    ["verify", verify],
  ] as const)("accepts the complete fixed recipe in %s mode", (mode, args) => {
    const raw = environment();
    const before = { ...raw };
    const argv = [...args];
    const command = datasetCommandEnvironment(args, raw);
    expect(command).toEqual({
      mode,
      context: {
        tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        actorUserId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        expectedDatabaseName: "markiro_us_dev",
        expectedDatabaseUser: "markiro_us",
      },
      version: "us-processor-six-month-v1",
      definitionDigest: "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
      env: expect.objectContaining({
        DATABASE_URL:
          "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev",
        PORT: 3100,
      }),
      planStorage: {
        endpoint: "http://127.0.0.1:19000",
        region: "us-east-1",
        bucket: "markiro-us-plans-command-test",
        accessKeyId: "synthetic-command-plan-access",
        secretAccessKey: "synthetic-command-plan-secret",
        forcePathStyle: true,
      },
      packageStorage: {
        endpoint: "http://127.0.0.1:19000",
        region: "us-east-1",
        bucket: "markiro-us-packages-command-test",
        accessKeyId: "synthetic-command-package-access",
        secretAccessKey: "synthetic-command-package-secret",
        forcePathStyle: true,
      },
    });
    expect(() => assertUsPlanArtifactStorageConfig(command.planStorage)).not.toThrow();
    expect(() => assertUsRequestPackageArtifactStorageConfig(command.packageStorage)).not.toThrow();
    expect(raw).toEqual(before);
    expect(args).toEqual(argv);
    expect(Object.isFrozen(raw)).toBe(false);
    expect(Object.isFrozen(args)).toBe(false);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.context)).toBe(true);
    expect(Object.isFrozen(command.planStorage)).toBe(true);
    expect(Object.isFrozen(command.packageStorage)).toBe(true);
    raw.DATABASE_URL = "changed-after-validation";
    expect(command.env.DATABASE_URL).toBe(before.DATABASE_URL);
  });

  it("accepts reordered explicit pairs and confirmation at the end", () => {
    const command = datasetCommandEnvironment(
      [
        "initialize",
        "--definition-digest",
        "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a",
        "--version",
        "us-processor-six-month-v1",
        "--owner-id",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "--tenant-id",
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "--database-user",
        "markiro_us",
        "--database-name",
        "markiro_us_dev",
        "--confirm-local-synthetic-dataset",
      ],
      environment(),
    );
    expect(command.mode).toBe("initialize");
    expect(command.context.actorUserId).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  const pairs = [
    ["--database-name", "markiro_us_dev"],
    ["--database-user", "markiro_us"],
    ["--tenant-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["--owner-id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["--version", "us-processor-six-month-v1"],
    ["--definition-digest", "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a"],
  ] as const;
  it.each(pairs)("refuses missing, valueless, empty or duplicated %s", (flag, value) => {
    const index = initialize.indexOf(flag);
    for (const args of [
      initialize.filter((_, position) => position !== index && position !== index + 1),
      initialize.filter((_, position) => position !== index + 1),
      [...initialize.slice(0, index), ...initialize.slice(index + 2), flag],
      withArgument(flag, ""),
      [...initialize, flag, value],
      [...initialize, flag, "different"],
    ])
      refusal(args, environment(), "us_dataset_command_arguments_invalid");
  });
  it.each([
    [],
    ["initialize"],
    ["verify"],
    ["reset", ...initialize.slice(1)],
    ["INITIALIZE", ...initialize.slice(1)],
    [" initialize", ...initialize.slice(1)],
    ["--confirm-local-synthetic-dataset", ...initialize],
    ["initialize", ...initialize.slice(2)],
    [...verify, "--confirm-local-synthetic-dataset"],
    [...initialize, "--confirm-local-synthetic-dataset"],
    [...initialize, "--confirm-local-synthetic-dataset=true"],
    [...initialize, "--confirm-local-synthetic-dataset", "true"],
    [...initialize, "--reset"],
    [...initialize, "--force"],
    [...initialize, "--start-index", "0"],
    [...initialize, "--end-index", "259"],
    [...initialize, "--range", "0..259"],
    [...initialize, "--database-url", "postgres://private:private@remote.invalid/db"],
    [...initialize, "--unknown", "value"],
    [...initialize, "trailing-token"],
    [...initialize, "--owner-id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"],
    ["verify", "markiro_us_dev", "markiro_us"],
  ])("refuses widened or incomplete argv %j", (...args) => {
    refusal(args, environment(), "us_dataset_command_arguments_invalid");
  });
  it.each([
    ["--database-name", "markiro"],
    ["--database-name", " markiro_us_dev"],
    ["--database-user", "postgres"],
    ["--database-user", "markiro_us "],
    ["--version", "us-processor-six-month-v2"],
    ["--version", "us-processor-six-month-v1 "],
    ["--definition-digest", "0".repeat(64)],
    ["--definition-digest", "F6BD2BCEAEB921EE0237157DFE6F2EA9F72ED31ADA816F6817F40E8E06EFDA5A"],
    ["--definition-digest", "f6bd2bceaeb921ee0237157dfe6f2ea9f72ed31ada816f6817f40e8e06efda5a "],
    ["--tenant-id", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
    ["--tenant-id", " aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ["--tenant-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n"],
    ["--tenant-id", "not-a-uuid"],
    ["--tenant-id", "aaaaaaaa-aaaa-4aaa-0aaa-aaaaaaaaaaaa"],
    ["--owner-id", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"],
    ["--owner-id", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb "],
    ["--owner-id", "not-a-uuid"],
    ["--owner-id", "bbbbbbbb-bbbb-0bbb-8bbb-bbbbbbbbbbbb"],
  ])("refuses malformed or mismatched %s (%s)", (flag, value) => {
    refusal(withArgument(flag, value), environment(), "us_dataset_command_arguments_invalid");
  });

  it.each([
    ["MARKIRO_DEPLOYMENT_EDITION", "RU"],
    ["MARKIRO_DEPLOYMENT_EDITION", "us"],
    ["MARKIRO_DEPLOYMENT_EDITION", undefined],
    ["VITE_DEPLOYMENT_EDITION", "RU"],
    ["VITE_DEPLOYMENT_EDITION", undefined],
    ["NODE_ENV", "production"],
    ["NODE_ENV", undefined],
    ["DATABASE_URL", "postgres://markiro_us:private-secret@remote.invalid:55432/markiro_us_dev"],
    ["DATABASE_URL", "postgres://markiro_us:private-secret@127.0.0.1:5432/markiro_us_dev"],
    ["DATABASE_URL", "postgres://other:private-secret@127.0.0.1:55432/markiro_us_dev"],
    ["DATABASE_URL", "postgres://markiro_us:private-secret@127.0.0.1:55432/markiro"],
    [
      "DATABASE_URL",
      "postgres://markiro_us:private-secret@127.0.0.1:55432/markiro_us_dev?host=remote.invalid",
    ],
    [
      "DATABASE_URL",
      "postgres://markiro_us:private-secret@127.0.0.1:55432/markiro_us_dev#fragment",
    ],
    ["DATABASE_URL", ""],
    ["S3_ENDPOINT", "http://127.0.0.1:9000"],
    ["S3_BUCKET", "general-other-bucket"],
    ["SMTP_HOST", "smtp.remote.invalid"],
    ["SMTP_PORT", "1025"],
    ["ADMIN_ORIGIN", "http://localhost:5173"],
    ["BETTER_AUTH_URL", "https://auth.remote.invalid"],
    ["PORT", "3000"],
  ] as const)("refuses unsafe environment %s", (field, value) => {
    for (const args of [initialize, verify])
      refusal(args, { ...environment(), [field]: value }, "us_dataset_command_environment_invalid");
  });

  it.each(["plan", "package"] as const)("requires complete %s storage in both modes", (kind) => {
    const fields = Object.keys(kind === "plan" ? plan : packages);
    for (const args of [initialize, verify]) {
      const raw = environment();
      for (const field of fields) delete raw[field];
      refusal(args, raw, "us_dataset_command_storage_unavailable");
      for (const field of fields) {
        const partial = environment();
        delete partial[field];
        refusal(
          args,
          partial,
          kind === "plan"
            ? "us_dataset_command_environment_invalid"
            : "us_dataset_command_storage_unavailable",
        );
      }
    }
  });
  it.each([
    ["ENDPOINT", "https://private-secret@remote.invalid"],
    ["ENDPOINT", "http://127.0.0.1:9000"],
    ["REGION", ""],
    ["BUCKET", "bad/bucket"],
    ["BUCKET", "markiro-us-development"],
    ["ACCESS_KEY_ID", ""],
    ["ACCESS_KEY_ID", "markiro_us"],
    ["SECRET_ACCESS_KEY", ""],
    ["SECRET_ACCESS_KEY", "markiro-us-development-only"],
    ["FORCE_PATH_STYLE", "false"],
  ])("refuses invalid or general-S3-shared private %s", (suffix, value) => {
    for (const args of [initialize, verify]) {
      refusal(
        args,
        { ...environment(), [`US_PLAN_ARTIFACT_S3_${suffix}`]: value },
        "us_dataset_command_environment_invalid",
      );
      refusal(
        args,
        { ...environment(), [`US_REQUEST_PACKAGE_S3_${suffix}`]: value },
        "us_dataset_command_storage_unavailable",
      );
    }
  });
});
