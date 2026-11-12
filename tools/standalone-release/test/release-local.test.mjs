import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { releaseStandaloneLocally } from "../release-local.mjs";
import { manifestFileName, updateFolderName } from "../sign-update.mjs";

const compact = "header.payload.signature";

async function fixture(t) {
  const outputDir = await realpath(await mkdtemp(join(tmpdir(), "standalone-release-local-test-")));
  t.after(() => rm(outputDir, { recursive: true, force: true }));
  const key = join(outputDir, "private.pem");
  await writeFile(key, "fixture only");
  return {
    outputDir,
    key,
    runId: "123",
    kid: "test-updates",
    minUpgradeFrom: "1.1.1",
  };
}

test("signs the verified CI artifact in the terminal and dispatches only public metadata", async (t) => {
  const options = await fixture(t);
  const calls = [];
  const prepared = { runId: "123", artifactId: "456", version: "1.7.0", sourceSha: "a".repeat(40) };
  const folder = join(options.outputDir, updateFolderName(prepared.version));
  const result = await releaseStandaloneLocally(options, {
    async loadArtifact(input) {
      assert.equal(input.runId, "123");
      assert.equal(input.repository, "thevladbog/markiro");
      assert.equal(input.artifactId, undefined);
      calls.push("load");
      return { ...prepared, directory: input.directory };
    },
    async run(command, args, runOptions) {
      if (command === process.execPath) {
        assert.match(args[0], /\/sign-update\.mjs$/u);
        assert.ok(args.includes(options.key));
        assert.equal(runOptions.stdio, "inherit");
        await mkdir(folder);
        await writeFile(join(folder, manifestFileName(prepared.version)), compact + "\n");
        calls.push("sign");
        return;
      }
      assert.equal(command, "gh");
      assert.deepEqual(args, [
        "workflow",
        "run",
        "standalone-stable-release.yml",
        "--repo",
        "thevladbog/markiro",
        "--ref",
        "standalone-publisher-v1",
        "--json",
      ]);
      assert.deepEqual(JSON.parse(runOptions.input), {
        ci_run_id: "123",
        artifact_id: "456",
        update_jws: compact,
      });
      assert.ok(!runOptions.input.includes(options.key));
      calls.push("dispatch");
    },
    async verifySigned(artifact, signed) {
      assert.equal(artifact.sourceSha, prepared.sourceSha);
      assert.equal(signed, compact);
      calls.push("verify");
    },
    report() {},
  });
  assert.deepEqual(calls, ["load", "sign", "verify", "dispatch"]);
  assert.equal(result.folder, folder);
});

test("a failed provenance check prevents signing and dispatch", async (t) => {
  const options = await fixture(t);
  await assert.rejects(
    releaseStandaloneLocally(options, {
      async loadArtifact() {
        throw new Error("CI did not pass");
      },
      run() {
        assert.fail("should not start any process");
      },
      report() {},
    }),
    /CI did not pass/u,
  );
});
