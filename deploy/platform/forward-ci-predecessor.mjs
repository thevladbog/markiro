/** Synthetic rehearsal only; this module is never installed in production. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "./backup/schemas.mjs";
export const failedEdgeExecutor = "0b6ab03da0d560a5946cf5ff3e5b8485d1d124ff";
export const stageFailedEdgeExecutor = (options) => stage(options, failedEdgeExecutor);
export const priorForwardExecutor = "cdae4e1ab3faf57c4941d8373aeba345fa0ef5de";
export const failedActivationExecutor = "9c5240964bcf8869838e5574015d2838f3c42d57";
export const stageForwardPredecessor = (options) => stage(options, priorForwardExecutor);
export const stageFailedActivationExecutor = (options) => stage(options, failedActivationExecutor);
async function stage({ parent, command }, executorSha) {
  const git = async (path) =>
    (await command("git", ["show", `${executorSha}:${path}`], { encoding: "buffer" })).stdout;
  const declarations = [];
  for (const [path, name] of [
    ["deploy/platform/host/recovery-command.mjs", "RECOVERY_BUNDLE_FILES"],
    ["deploy/platform/host/upgrade-command.mjs", "UPGRADE_BUNDLE_FILES"],
  ]) {
    const source = String(await git(path)),
      start = source.indexOf(`export const ${name} = Object.freeze([`),
      end = source.indexOf("]);", start);
    assert.ok(start >= 0 && end > start);
    declarations.push(
      ...[...source.slice(start, end).matchAll(/"(deploy\/[a-zA-Z0-9_./-]+)"/gu)].map((m) => m[1]),
    );
  }
  const paths = [...new Set(declarations)];
  assert.ok(paths.length >= 40 && paths.length <= 256);
  const installedRoot = join(parent, "upgrade-bootstrap", executorSha),
    files = {};
  for (const path of paths) {
    assert.ok(!path.split("/").some((p) => !p || p === "." || p === ".."));
    const bytes = await git(path),
      destination = join(installedRoot, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, {
      mode: path.endsWith("pg_hba.conf") ? 0o644 : 0o600,
      flag: "wx",
    });
    files[path] = digest(bytes);
  }
  const verify = async () => {
    for (const [path, sha] of Object.entries(files))
      assert.equal(digest(await readFile(join(installedRoot, path))), sha);
  };
  await verify();
  const load = (path) => import(pathToFileURL(join(installedRoot, path)).href);
  const preparation = await load("deploy/platform/host/forward-preparation.mjs"),
    product = await load("deploy/platform/host/forward-product.mjs"),
    observation = await load("deploy/platform/host/forward-observation.mjs"),
    reads = await load(
      files["deploy/platform/host/admission-read-failure.mjs"]
        ? "deploy/platform/host/admission-read-failure.mjs"
        : "deploy/platform/admission-read-failure.mjs",
    );
  const state = await load("deploy/platform/host/forward-state.mjs"),
    backup = await load("deploy/platform/host/target-backup.mjs"),
    commandModule = await load("deploy/platform/host/upgrade-command.mjs"),
    retained = await load("deploy/platform/host/forward-retained.mjs"),
    probe = await load("deploy/platform/host/probe.mjs"),
    ledger = await load("deploy/platform/host/forward-ledger.mjs");
  return {
    state,
    ledger,
    probe,
    backup,
    command: commandModule,
    retained,
    executorSha,
    installedRoot,
    files,
    verify,
    preparation,
    product,
    observation,
    reads,
  };
}
