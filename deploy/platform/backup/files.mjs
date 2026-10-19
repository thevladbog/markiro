import { constants } from "node:fs";
import { open, lstat, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { assertPrivateRootSync, syncPrivateDirectory, privateFileError } from "../host/files.mjs";

function pathInRoot(root, path) {
  assertPrivateRootSync(root);
  const rel = relative(root, path);
  if (!rel || rel.startsWith(".") || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(rel))
    throw privateFileError();
  assertPrivateRootSync(dirname(path));
}
function metadata(info) {
  if (
    !info.isFile() ||
    info.uid !== process.getuid() ||
    (info.mode & 0o7777) !== 0o600 ||
    info.nlink !== 1
  )
    throw privateFileError();
}
function unchanged(a, b) {
  return ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every((k) => a[k] === b[k]);
}
async function stream(root, path, onChunk) {
  pathInRoot(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    metadata(await handle.stat());
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(65536);
    let bytes = 0;
    while (true) {
      const result = await handle.read(buffer, 0, buffer.length, null);
      if (!result.bytesRead) break;
      const chunk = buffer.subarray(0, result.bytesRead);
      hash.update(chunk);
      bytes += chunk.length;
      await onChunk?.(chunk);
    }
    const after = await handle.stat({ bigint: true });
    metadata(await handle.stat());
    if (
      !unchanged(before, after) ||
      !unchanged(before, await lstat(path, { bigint: true })) ||
      BigInt(bytes) !== before.size
    )
      throw privateFileError();
    return { path, sha256: hash.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}
export const hashArchive = (root, path) => stream(root, path);
export async function publishArchive(root, source, name, { sourceRoot = root } = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(name)) throw privateFileError();
  const destination = join(root, name),
    scratch = join(root, `archive-${randomUUID()}.partial`);
  pathInRoot(root, destination);
  let handle;
  try {
    handle = await open(
      scratch,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const result = await stream(sourceRoot, source, async (chunk) => {
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await handle.write(chunk, offset);
        if (!bytesWritten) throw privateFileError();
        offset += bytesWritten;
      }
    });
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(scratch, destination);
    await unlink(scratch);
    await syncPrivateDirectory(root);
    return { ...result, path: destination };
  } finally {
    await handle?.close();
    await unlink(scratch).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
