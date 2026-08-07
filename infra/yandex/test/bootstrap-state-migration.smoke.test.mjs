import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";

import * as smoke from "./bootstrap-state-migration.smoke.mjs";

const script = path.join(import.meta.dirname, "bootstrap-state-migration.smoke.mjs");

test("clean bootstrap state is applied locally then migrated to disposable S3", async (context) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "markiro-smoke-main-"));
  try {
    const output = execFileSync(process.execPath, [script], {
      encoding: "utf8",
      env: { ...process.env, TMPDIR: temporaryDirectory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(output, "MIGRATION_VERIFIED\n");
  } catch (error) {
    const listenerCode = smoke.listenerPolicyErrorCode(error);
    if (smoke.shouldSkipListenerFailure(error, process.env)) {
      context.skip(`the sandbox denied the disposable S3 listener with ${listenerCode}`);
    } else {
      assert.fail(error.stderr?.toString("utf8") || error.message);
    }
  } finally {
    assert.deepEqual(await readdir(temporaryDirectory), []);
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("missing Terraform fails and cannot be classified as a listener skip", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "markiro-smoke-missing-bin-"));
  try {
    await assert.rejects(
      smoke.runBootstrapStateMigrationSmoke({
        environment: process.env,
        temporaryDirectory,
        terraform: path.join(temporaryDirectory, "missing-terraform"),
      }),
      (error) => error?.code === "ENOENT" && smoke.listenerPolicyErrorCode(error) === undefined,
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("default Terraform executable is resolved from PATH", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "markiro-smoke-path-"));
  const binaryDirectory = path.join(temporaryDirectory, "bin");
  const marker = path.join(temporaryDirectory, "terraform-arguments.txt");
  const environment = { ...process.env };
  delete environment.MARKIRO_TERRAFORM_BIN;
  await mkdir(binaryDirectory);
  const fakeTerraform = path.join(binaryDirectory, "terraform");
  await writeFile(
    fakeTerraform,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$MARKIRO_FAKE_TERRAFORM_LOG"\n',
  );
  await chmod(fakeTerraform, 0o700);
  try {
    await assert.rejects(
      smoke.runBootstrapStateMigrationSmoke({
        environment: {
          ...environment,
          PATH: `${binaryDirectory}:${process.env.PATH ?? ""}`,
          MARKIRO_DISPOSABLE_S3_FORCE_LISTENER_ERROR: "EPERM",
          MARKIRO_FAKE_TERRAFORM_LOG: marker,
        },
        temporaryDirectory,
      }),
      (error) => smoke.listenerPolicyErrorCode(error) === "EPERM",
    );
    assert.equal(await readFile(marker, "utf8"), "version -json\n");
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("only exact listener EPERM and EACCES failures are skippable", () => {
  for (const code of ["EPERM", "EACCES"])
    assert.equal(
      smoke.listenerPolicyErrorCode({ stderr: `DISPOSABLE_S3_LISTENER_ERROR:${code}\n` }),
      code,
    );
  for (const error of [
    { code: "ENOENT" },
    { stderr: "ERROR: EPERM\n" },
    { stderr: "DISPOSABLE_S3_LISTENER_ERROR:ENOENT\n" },
    { stderr: "prefix DISPOSABLE_S3_LISTENER_ERROR:EPERM\n" },
  ])
    assert.equal(smoke.listenerPolicyErrorCode(error), undefined);

  const listenerError = { stderr: "DISPOSABLE_S3_LISTENER_ERROR:EPERM\n" };
  assert.equal(smoke.shouldSkipListenerFailure(listenerError, { CI: "false" }), true);
  assert.equal(smoke.shouldSkipListenerFailure(listenerError, { CI: "true" }), false);
});

test("hung child cleanup escalates from TERM to KILL within the bound", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.on("SIGTERM", () => {}); process.stdout.write("READY\\n"); setInterval(() => {}, 1000)',
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  await once(child.stdout, "data");
  const startedAt = performance.now();
  await smoke.stopChildProcess(child, { killTimeoutMs: 500, termTimeoutMs: 50 });
  assert.ok(performance.now() - startedAt < 1_000);
  assert.equal(child.signalCode, "SIGKILL");
});

test("listener startup failure removes every temporary state artifact", async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "markiro-smoke-cleanup-"));
  try {
    await assert.rejects(
      smoke.runBootstrapStateMigrationSmoke({
        environment: {
          ...process.env,
          MARKIRO_DISPOSABLE_S3_FORCE_LISTENER_ERROR: "EACCES",
        },
        temporaryDirectory,
        terraform: "/usr/bin/true",
      }),
      (error) => smoke.listenerPolicyErrorCode(error) === "EACCES",
    );
    assert.deepEqual(await readdir(temporaryDirectory), []);
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});
