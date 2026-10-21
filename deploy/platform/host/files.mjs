import { constants, lstatSync, realpathSync } from "node:fs";
import { link, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize, parse } from "node:path";

const maxBytes = 1024 * 1024;
const uid = () => process.getuid();
// Explicit opt-in for bounded database inventory documents. Control files keep
// the default 1 MiB limit; callers cannot request an unbounded allocation.
export const inventoryDocumentOptions = Object.freeze({ maxBytes: 2 * maxBytes });
function fileOptions(options, allowReplace = false) {
  if (!options || ![Object.prototype, null].includes(Object.getPrototypeOf(options)))
    throw privateFileError();
  for (const key of Reflect.ownKeys(options)) {
    const d = Object.getOwnPropertyDescriptor(options, key);
    if (
      !d.enumerable ||
      !Object.hasOwn(d, "value") ||
      (key !== "maxBytes" && !(allowReplace && key === "replace"))
    )
      throw privateFileError();
  }
  const limit = Object.hasOwn(options, "maxBytes") ? options.maxBytes : maxBytes;
  if (
    ![maxBytes, inventoryDocumentOptions.maxBytes].includes(limit) ||
    (Object.hasOwn(options, "replace") && typeof options.replace !== "boolean")
  )
    throw privateFileError();
  return { limit, replace: options.replace ?? false };
}

export function privateFileError(durabilityUncertain = false) {
  const error = new Error("Protected host file operation failed.");
  error.code = "ERR_HOST_PRIVATE_FILE";
  error.durabilityUncertain = durabilityUncertain;
  return error;
}

function absolutePath(path) {
  if (
    typeof path !== "string" ||
    !isAbsolute(path) ||
    normalize(path) !== path ||
    (path !== parse(path).root && path.endsWith("/")) ||
    [...path].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw privateFileError();
  return path;
}

function directoryChain(path, privateFrom) {
  absolutePath(path);
  let current = parse(path).root;
  for (const part of ["", ...path.slice(current.length).split("/").filter(Boolean)]) {
    if (part) current = join(current, part);
    const info = lstatSync(current);
    const privateDirectory =
      privateFrom && (current === privateFrom || current.startsWith(`${privateFrom}/`));
    const stickyTemporaryAncestor =
      !privateDirectory && info.uid === 0 && (info.mode & 0o1000) !== 0;
    if (
      !info.isDirectory() ||
      ![0, uid()].includes(info.uid) ||
      (privateDirectory
        ? info.uid !== uid() || (info.mode & 0o7777) !== 0o700
        : (info.mode & 0o022) !== 0 && !stickyTemporaryAncestor)
    )
      throw privateFileError();
  }
  if (realpathSync(path) !== path) throw privateFileError();
}

export function assertPrivateRootSync(root) {
  try {
    absolutePath(root);
    directoryChain(root, root);
  } catch {
    throw privateFileError();
  }
}

export async function assertPrivateRoot(root) {
  assertPrivateRootSync(root);
}

function descendant(root, relativePath) {
  assertPrivateRootSync(root);
  if (
    typeof relativePath !== "string" ||
    !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9_-][a-zA-Z0-9._-]*)*$/u.test(relativePath)
  )
    throw privateFileError();
  const path = join(root, relativePath);
  directoryChain(dirname(path), root);
  return path;
}

function fileMetadata(info, privateFile, limit = maxBytes) {
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.size > limit ||
    (privateFile ? info.uid !== uid() || (info.mode & 0o7777) !== 0o600 : (info.mode & 0o022) !== 0)
  )
    throw privateFileError();
}

// Bind sources can be owned/read by a container UID. This only checks filesystem
// safety, not TLS validity, actual container access or the PostgreSQL UID/GID.
export function assertBindFileSync(path) {
  try {
    absolutePath(path);
    directoryChain(dirname(path));
    fileMetadata(lstatSync(path), false);
    if (realpathSync(path) !== path) throw privateFileError();
  } catch {
    throw privateFileError();
  }
}

export function assertPrivateFileSync(path) {
  try {
    absolutePath(path);
    assertPrivateRootSync(dirname(path));
    fileMetadata(lstatSync(path), true);
    if (realpathSync(path) !== path) throw privateFileError();
  } catch {
    throw privateFileError();
  }
}

export async function readPrivateFile(root, relativePath, options = {}) {
  let handle;
  try {
    const { limit } = fileOptions(options);
    const path = descendant(root, relativePath);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    fileMetadata(await handle.stat(), true, limit);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw privateFileError();
    fileMetadata(await handle.stat(), true, limit);
    await handle.close();
    handle = undefined;
    return buffer.subarray(0, length);
  } catch {
    throw privateFileError();
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function syncPrivateDirectory(path) {
  let handle;
  try {
    assertPrivateRootSync(path);
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch {
    throw privateFileError(true);
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function createPrivateDirectory(root, relativePath, { exclusive = true } = {}) {
  let created = false;
  try {
    const path = descendant(root, relativePath);
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (exclusive || error.code !== "EEXIST") throw privateFileError();
    }
    directoryChain(path, root);
    if (created) await syncPrivateDirectory(dirname(path));
  } catch (error) {
    throw privateFileError(created || error.durabilityUncertain === true);
  }
}

// The caller must own the deployment directory lock when using replace. Node's
// path checks do not provide openat-style protection from hostile root/UID peers.
export async function writePrivateFile(root, relativePath, bytes, options = {}) {
  let handle;
  let scratch;
  let durabilityUncertain = false;
  try {
    const { limit, replace } = fileOptions(options, true);
    const path = descendant(root, relativePath);
    if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array) || bytes.byteLength > limit)
      throw privateFileError();
    if (typeof replace !== "boolean") throw privateFileError();
    if (replace) {
      try {
        fileMetadata(lstatSync(path), true, limit);
      } catch (error) {
        if (error.code !== "ENOENT") throw privateFileError();
      }
    }
    const candidate = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    handle = await open(
      candidate,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    scratch = candidate;
    fileMetadata(await handle.stat(), true);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) {
      durabilityUncertain = true;
      await rename(scratch, path);
      scratch = undefined;
    } else {
      try {
        await link(scratch, path);
      } catch (error) {
        durabilityUncertain = error.code !== "EEXIST";
        throw privateFileError();
      }
      durabilityUncertain = true;
      await unlink(scratch);
      scratch = undefined;
    }
    await syncPrivateDirectory(dirname(path));
  } catch (error) {
    throw privateFileError(durabilityUncertain || error.durabilityUncertain === true);
  } finally {
    await handle?.close().catch(() => {});
    if (scratch) await unlink(scratch).catch(() => {});
  }
}
