import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
function fail() {
  throw new Error("invalid publisher catalog journal; reconcile before retry");
}
function privateStat(info, directory = false) {
  if (
    info.isSymbolicLink() ||
    (directory ? !info.isDirectory() : !info.isFile()) ||
    (!directory && info.nlink !== 1)
  )
    fail();
  if (
    process.platform !== "win32" &&
    ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid())
  )
    fail();
}
export async function publisherJournal(path) {
  if (typeof path !== "string" || resolve(path) !== path) fail();
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
  }
  privateStat(await lstat(path), true);
  const directory = await realpath(path);
  async function read(name) {
    const file = join(directory, name);
    let info;
    try {
      info = await lstat(file);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    privateStat(info);
    if (info.size < 1 || info.size > 262144) fail();
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const current = await handle.stat();
      if (current.ino !== info.ino || current.dev !== info.dev) fail();
      return JSON.parse(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  }
  async function write(name, value) {
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length > 262144) fail();
    const handle = await open(
      join(directory, name),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    // NTFS does not expose directory fsync through Node; protected runner temp is the boundary there.
    if (process.platform !== "win32") {
      const dir = await open(directory, constants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  return {
    read,
    write,
    async retain(name, value) {
      const old = await read(name);
      if (old !== null) {
        if (!isDeepStrictEqual(old, value)) fail();
        return;
      }
      await write(name, value);
    },
  };
}
