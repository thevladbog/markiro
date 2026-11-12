import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const helper = fileURLToPath(new URL("../runtime-archive.py", import.meta.url));
const roots = [
  "node_modules",
  "packages/domain/node_modules",
  "packages/domain/dist",
  "packages/platform-contracts/node_modules",
  "packages/platform-contracts/dist",
];

function python(cwd, ...args) {
  return spawnSync("python3", ["-I", ...args], { cwd, encoding: "utf8" });
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "publisher-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await Promise.all([
    ...roots.map((name) => mkdir(join(source, name), { recursive: true })),
    ...["domain", "platform-contracts"].map((name) =>
      mkdir(join(target, "packages", name), { recursive: true }),
    ),
  ]);
  return { source, target, archive: join(root, "runtime.zip") };
}

test("transfers only runtime roots and preserves relative pnpm workspace and package links", async (t) => {
  const { source, target, archive } = await fixture(t);
  await mkdir(join(source, "node_modules/.pnpm/example"), { recursive: true });
  await writeFile(join(source, "node_modules/.pnpm/example/package.json"), "{}");
  await symlink(".pnpm/example", join(source, "node_modules/example"));
  const scope = "packages/platform-contracts/node_modules/@markiro";
  await mkdir(join(source, scope));
  await symlink("../../../domain", join(source, scope, "domain"));
  await writeFile(join(source, "packages/domain/dist/index.js"), "export {};");
  await writeFile(join(source, "outside-runtime.mjs"), "excluded");

  const packed = python(source, helper, "pack", archive);
  assert.equal(packed.status, 0, packed.stderr);
  const digest = packed.stdout.trim();
  assert.match(digest, /^[a-f0-9]{64}$/u);

  const wrong = python(target, helper, "restore", archive, "0".repeat(64));
  assert.equal(wrong.status, 1, wrong.stderr);
  await assert.rejects(access(join(target, "node_modules")), { code: "ENOENT" });

  const restored = python(target, helper, "restore", archive, digest);
  assert.equal(restored.status, 0, restored.stderr);
  assert.equal(await readFile(join(target, "node_modules/example/package.json"), "utf8"), "{}");
  assert.equal(await readlink(join(target, scope, "domain")), "../../../domain");
  assert.equal(await readFile(join(target, scope, "domain/dist/index.js"), "utf8"), "export {};");
  await assert.rejects(access(join(target, "outside-runtime.mjs")), { code: "ENOENT" });

  const duplicate = python(target, helper, "restore", archive, digest);
  assert.equal(duplicate.status, 1, duplicate.stderr);
  assert.equal(await readFile(join(target, "node_modules/example/package.json"), "utf8"), "{}");
});

test("refuses archives with traversal, duplicates, special files, and symlink escapes", async (t) => {
  const { target, archive } = await fixture(t);
  const attacks = [
    ["node_modules/../overwrite", "file", "unexpected"],
    ["package.json", "file", "unexpected"],
    ["node_modules/", "directory", ""],
    ["node_modules/pipe", "fifo", ""],
    ["node_modules/escape", "symlink", "../package.json"],
    ["node_modules/missing-parent/file", "file", "unexpected"],
  ];
  const createArchive = `
import json, stat, sys, zipfile
modes = {"file": stat.S_IFREG, "directory": stat.S_IFDIR,
         "fifo": stat.S_IFIFO, "symlink": stat.S_IFLNK}
roots, attack = json.loads(sys.argv[2])
with zipfile.ZipFile(sys.argv[1], "w") as archive:
    for name, kind, data in [[root + "/", "directory", ""] for root in roots] + [attack]:
        info = zipfile.ZipInfo(name)
        info.create_system = 3
        info.external_attr = (modes[kind] | 0o755) << 16
        archive.writestr(info, data)
`;
  for (const attack of attacks) {
    const made = python(target, "-c", createArchive, archive, JSON.stringify([roots, attack]));
    assert.equal(made.status, 0, made.stderr);
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    const restored = python(target, helper, "restore", archive, digest);
    assert.equal(restored.status, 1, attack[0]);
    await assert.rejects(access(join(target, "node_modules")), { code: "ENOENT" });
  }
});
