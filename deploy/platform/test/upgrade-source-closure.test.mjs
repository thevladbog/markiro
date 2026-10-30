import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFixture } from "./host-fixtures.mjs";
import { HOST_BUNDLE_FILES } from "../host/command.mjs";
import { RECOVERY_BUNDLE_FILES } from "../host/recovery-command.mjs";
import { UPGRADE_BUNDLE_FILES } from "../host/upgrade-command.mjs";

for (const [kind, files, entry] of [
  ["ordinary", HOST_BUNDLE_FILES, "deploy/platform/host/command.mjs"],
  ["recovery", RECOVERY_BUNDLE_FILES, "deploy/platform/host/recovery-command-runtime.mjs"],
  ["upgrade", UPGRADE_BUNDLE_FILES, "deploy/platform/host/upgrade-command-runtime.mjs"],
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
        `await import(${JSON.stringify(pathToFileURL(join(f.root, entry)).href)})`,
      ],
      {
        cwd: f.root,
        env: { PATH: "/usr/bin:/bin" },
        timeout: 10000,
      },
    );
  });
