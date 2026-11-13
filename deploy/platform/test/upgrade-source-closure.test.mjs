import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFixture } from "./host-fixtures.mjs";
import { HOST_BUNDLE_FILES } from "../host/command.mjs";
import { RECOVERY_BUNDLE_FILES } from "../host/recovery-command.mjs";
import { UPGRADE_BUNDLE_FILES, upgradeBundleFiles } from "../host/upgrade-command.mjs";
import { HEALTHY_FORWARD_ROLLOUT_PHASE } from "../upgrade-dispatch.mjs";
import { buildSourceBundle, validateBundle } from "../upgrade-transport.mjs";

const healthyFiles = upgradeBundleFiles(HEALTHY_FORWARD_ROLLOUT_PHASE);

for (const [kind, files, ...entries] of [
  ["ordinary", HOST_BUNDLE_FILES, "deploy/platform/host/command.mjs"],
  ["recovery", RECOVERY_BUNDLE_FILES, "deploy/platform/host/recovery-command-runtime.mjs"],
  ["upgrade", UPGRADE_BUNDLE_FILES, "deploy/platform/host/upgrade-command-runtime.mjs"],
  [
    "healthy forward rollout",
    healthyFiles,
    "deploy/platform/host/healthy-forward-rollout-runtime.mjs",
    "deploy/platform/host/healthy-forward-rollout-state.mjs",
    "deploy/platform/host/healthy-forward-backup.mjs",
    "deploy/platform/host/healthy-forward-candidate.mjs",
    "deploy/platform/host/healthy-forward-predecessor.mjs",
    "deploy/platform/upgrade-transport.mjs",
  ],
])
  test(`${kind} installation contains the full transitive executable closure after upgrade additions`, async (t) => {
    const f = await privateFixture(t);
    const source = fileURLToPath(new URL("../../../", import.meta.url));
    assert.equal(files.length, new Set(files).size);
    for (const path of files) {
      const target = join(f.root, path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(source, path), target);
    }
    await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        entries
          .map(
            (entry) => `await import(${JSON.stringify(pathToFileURL(join(f.root, entry)).href)})`,
          )
          .join("\n"),
      ],
      {
        cwd: f.root,
        env: { PATH: "/usr/bin:/bin" },
        timeout: 10000,
      },
    );
  });

test("healthy forward delivery uses its distinct closure within the full wire limit", async (t) => {
  const { root } = await privateFixture(t);
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  const executorSha = "a".repeat(40);
  const ciRunId = "12345678901";
  const selection = {
    executorSha,
    executorCiRunId: ciRunId,
    executorCiRunAttempt: "1",
    sourceSha: "b".repeat(40),
    workflowRunId: ciRunId,
    workflowRunAttempt: "1",
    artifactId: ciRunId,
    operationId: "11111111-1111-4111-8111-111111111111",
  };
  const phase = HEALTHY_FORWARD_ROLLOUT_PHASE;
  const dispatch = { toolingSha: executorSha, runId: ciRunId, runAttempt: "1" };
  const { bundle, receipt } = await buildSourceBundle(selection, source, root, dispatch, {
    phase,
    runProcess: async ({ executable, args }) => {
      assert.equal(executable, "/usr/bin/git");
      assert.equal(args[2], "show");
      assert.ok(args[3].startsWith(executorSha + ":"));
      return { stdout: await readFile(join(source, args[3].slice(41))) };
    },
  });
  assert.deepEqual(Object.keys(validateBundle(bundle, receipt, phase)), healthyFiles);
  assert.throws(() => validateBundle(bundle, receipt, "post-migration-activate"));
  assert.ok(Buffer.byteLength(JSON.stringify({ bundle, phase, dispatch })) <= 1048576);
  const historical = "post-migration-activate";
  const previous = await buildSourceBundle(selection, source, root, dispatch, {
    phase: historical,
    runProcess: async ({ executable, args }) => {
      assert.equal(executable, "/usr/bin/git");
      assert.equal(args[2], "show");
      assert.ok(args[3].startsWith(executorSha + ":"));
      return { stdout: await readFile(join(source, args[3].slice(41))) };
    },
  });
  assert.deepEqual(
    Object.keys(validateBundle(previous.bundle, previous.receipt, historical)),
    UPGRADE_BUNDLE_FILES,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify({ bundle: previous.bundle, phase: historical, dispatch })) <=
      1048576,
  );
});
