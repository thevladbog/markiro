/** Synthetic rehearsal only; this module is never installed in production. */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { digest } from "./backup/schemas.mjs";
export const priorForwardExecutor = "cdae4e1ab3faf57c4941d8373aeba345fa0ef5de";
export async function stageForwardPredecessor({ parent, command }) {
  const git = async (path) =>
    (await command("git", ["show", `${priorForwardExecutor}:${path}`], { encoding: "buffer" }))
      .stdout;
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
  const installedRoot = join(parent, "upgrade-bootstrap", priorForwardExecutor),
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
    reads = await load("deploy/platform/admission-read-failure.mjs");
  return {
    executorSha: priorForwardExecutor,
    installedRoot,
    files,
    verify,
    preparation,
    product,
    observation,
    reads,
  };
}
