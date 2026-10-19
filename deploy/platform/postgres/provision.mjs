import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const failure = () => new Error("Private PostgreSQL role provisioning failed.");

// Local test adapters supply an explicit Docker endpoint/config and owned target.
// SQL stays on stdin: no root exec, shell, world-readable file, or secret argv.
export async function provisionRoles({
  executable = "docker",
  prefix,
  container,
  env,
  sqlFile,
  signal,
  compose = false,
}) {
  let file;
  try {
    file = await open(sqlFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await file.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size < 1 || stat.size > 65536)
      throw failure();
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead !== stat.size || bytesRead > 65536) throw failure();
    const input = buffer.subarray(0, bytesRead);
    await new Promise((resolve, reject) => {
      let inputFailed = false;
      const child = execFile(
        executable,
        [
          ...prefix,
          "exec",
          compose ? "-T" : "-i",
          "--user",
          "postgres",
          container,
          "psql",
          "-X",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          "postgres",
          "-d",
          "markiro",
        ],
        { env, timeout: 180000, maxBuffer: 65536, signal, shell: false },
        (error) => (error || inputFailed ? reject(failure()) : resolve()),
      );
      child.stdin.on("error", () => {
        inputFailed = true;
      });
      child.stdin.end(input);
    });
  } catch {
    throw failure();
  } finally {
    await file?.close();
  }
}
