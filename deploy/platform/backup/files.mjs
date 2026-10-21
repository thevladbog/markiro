import { constants } from "node:fs";
import { open, lstat, link, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { assertPrivateRootSync, syncPrivateDirectory, privateFileError } from "../host/files.mjs";

function archivePrivateError(reason) {
  const error = privateFileError();
  error.archiveReason = reason;
  return error;
}
function pathInRoot(root, path) {
  try {
    assertPrivateRootSync(root);
  } catch {
    throw archivePrivateError("root");
  }
  const rel = relative(root, path);
  if (!rel || rel.startsWith(".") || !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(rel))
    throw archivePrivateError("path");
  try {
    assertPrivateRootSync(dirname(path));
  } catch {
    throw archivePrivateError("parent");
  }
}
function metadata(info) {
  if (!info.isFile()) throw archivePrivateError("type");
  if (info.uid !== process.getuid()) throw archivePrivateError("owner");
  if ((info.mode & 0o7777) !== 0o600) throw archivePrivateError("mode");
  if (info.nlink !== 1) throw archivePrivateError("links");
}
function assertUnchanged(a, b, observation) {
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
    if (a[key] !== b[key]) throw archivePrivateError(`${observation}-${key}`);
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
    assertUnchanged(before, after, "opened");
    assertUnchanged(before, await lstat(path, { bigint: true }), "path");
    if (BigInt(bytes) !== before.size) throw archivePrivateError("read-length");
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
