/** Narrow file/command adapter. Never expose Docker output or credential-bearing errors. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { sha256RegularFile } from "./release-evidence.mjs";
const exec = promisify(execFile);

export const releaseIo = {
  hash: sha256RegularFile,
  async readText(path) {
    const before = await sha256RegularFile(path);
    const value = await fs.readFile(path, "utf8");
    if (
      createHash("sha256").update(value).digest("hex") !== before ||
      (await sha256RegularFile(path)) !== before
    )
      throw new Error("invalid release file");
    return value;
  },
  async createDirectory(path) {
    await fs.mkdir(path, { mode: 0o700 });
  },
  async writeJson(path, value) {
    await fs.writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  },
  async run(args) {
    try {
      return (
        await exec("docker", args, { timeout: 20 * 60 * 1000, maxBuffer: 1024 * 1024 })
      ).stdout.trim();
    } catch {
      throw new Error("platform image command failed");
    }
  },
};
