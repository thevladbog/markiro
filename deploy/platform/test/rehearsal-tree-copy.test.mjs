import test from "node:test";
import assert from "node:assert/strict";
import { cp, chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { privateFixture } from "./host-fixtures.mjs";
import { digest } from "../backup/schemas.mjs";
import * as rehearsal from "../upgrade-ci.mjs";
import { runHostProcess } from "../host/process.mjs";

for (const corrupt of [false, "bytes", "mode", "directory", "oversize"])
  test(`large rehearsal source tree uses verified directory transport: ${corrupt}`, async (t) => {
    const source = await privateFixture(t, { nested: true });
    const target = await privateFixture(t, { nested: true });
    const bytes = Buffer.alloc(corrupt === "oversize" ? 4 * 1048576 : 1361080, 65);
    await writeFile(join(source.root, "source.mjs"), bytes, { mode: 0o600 });
    const containerId = "a".repeat(64);
    const remote = (path) => {
      assert.ok(path === source.root || path.startsWith(`${source.root}/`));
      return join(target.root, path.slice(source.root.length));
    };
    let copies = 0;
    const io = {
      containerId,
      archive: async (directory) =>
        (
          await promisify(execFile)("/usr/bin/tar", ["-C", directory, "-cf", "-", "."], {
            encoding: "buffer",
            maxBuffer: 8 * 1048576,
          })
        ).stdout,
      outer: async (args) => {
        assert.deepEqual(args, ["cp", `${source.root}/.`, `${containerId}:${source.root}`]);
        copies++;
        await cp(source.root, target.root, { recursive: true });
        if (corrupt === "bytes") await writeFile(join(target.root, "source.mjs"), "changed");
        if (corrupt === "mode") await chmod(join(target.root, "source.mjs"), 0o644);
        if (corrupt === "directory") await chmod(join(target.root, "pg"), 0o755);
      },
      shell: async (args) => {
        const path = remote(args.at(-1));
        if (args[0] === "mkdir") {
          assert.deepEqual(args.slice(0, -1), ["mkdir", "-p", "-m", "700"]);
          return { stdout: "" };
        }
        if (args[0] === "chmod") {
          assert.equal(args[1], "700");
          await chmod(path, 0o700);
          return { stdout: "" };
        }
        const stat = await lstat(path);
        if (args[0] === "sha256sum")
          return { stdout: `${digest(await readFile(path))}  ${args.at(-1)}\n` };
        assert.equal(args[0], "stat");
        assert.equal(args[1], "-c");
        return {
          stdout: `${(stat.mode & 0o777).toString(8)}:${args[2] === "%a:%F" ? (stat.isDirectory() ? "directory" : "regular file") : stat.size}\n`,
        };
      },
    };
    if (corrupt) await assert.rejects(() => rehearsal.copyRehearsalTree(source.root, io));
    else {
      const result = await rehearsal.copyRehearsalTree(source.root, io);
      assert.ok(result.bytes > 1048576);
      assert.deepEqual(await readFile(join(target.root, "source.mjs")), bytes);
      // Directory transport does not widen the ordinary control process input cap.
      await assert.rejects(
        runHostProcess({
          executable: "/usr/bin/true",
          args: [],
          cwd: source.root,
          env: { PATH: "/usr/bin:/bin" },
          input: bytes,
          timeoutMs: 10000,
          outputLimitBytes: 1048576,
        }),
        (error) => error.code === "ERR_HOST_PROCESS" && error.reason === "spawn",
      );
    }
    assert.equal(copies, corrupt === "oversize" ? 0 : 1);
  });
