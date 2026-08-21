import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { basename, posix, resolve, sep } from "node:path";

const defaultFilesystem = {
  constants: fsConstants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
};

// Node has no portable openat or Windows reparse-point no-follow API. These
// primitives bind reads to open handles and recheck root/ancestor identities;
// callers must not treat them as a sandbox against an attacker who can perform
// undetectable ABA swaps in the package directory.

export class EvidencePackageError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "EvidencePackageError";
  }
}

export function invalid(message, options) {
  throw new EvidencePackageError(message, options);
}

export function evidenceFilesystem(options = {}) {
  const injected = options.filesystem ?? {};
  return {
    ...defaultFilesystem,
    ...injected,
    constants: injected.constants ?? fsConstants,
  };
}

function openFlags(filesystem, directory) {
  const constants = filesystem.constants ?? {};
  if (!Number.isInteger(constants.O_RDONLY)) {
    invalid("stable filesystem handle checks are unavailable on this platform");
  }
  let flags = constants.O_RDONLY;
  if (Number.isInteger(constants.O_NOFOLLOW)) flags |= constants.O_NOFOLLOW;
  if (directory && Number.isInteger(constants.O_DIRECTORY)) flags |= constants.O_DIRECTORY;
  return flags;
}

function statIdentityAvailable(information) {
  const supported = (value) =>
    typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value));
  return (
    supported(information?.dev) &&
    supported(information?.ino) &&
    information.ino !== 0 &&
    information.ino !== 0n
  );
}

function sameIdentity(left, right) {
  if (!statIdentityAvailable(left) || !statIdentityAvailable(right)) {
    invalid("stable filesystem identity fields are unavailable on this platform");
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function assertIdentity(expected, actual, label) {
  if (!sameIdentity(expected, actual)) invalid(`filesystem identity changed: ${label}`);
}

function assertType(information, type, label) {
  if (information.isSymbolicLink()) invalid(`symlink is not allowed: ${label}`);
  if (type === "directory" && !information.isDirectory()) {
    invalid(`path is not a directory: ${label}`);
  }
  if (type === "file" && !information.isFile()) invalid(`path is not a regular file: ${label}`);
}

async function bigintLstat(filesystem, path) {
  return filesystem.lstat(path, { bigint: true });
}

async function bigintFstat(handle) {
  return handle.stat({ bigint: true });
}

function displayLabel(relativePath) {
  if (!relativePath) return "root";
  return relativePath.length > 180 ? `${relativePath.slice(0, 177)}...` : relativePath;
}

function containedPath(session, relativePath) {
  const target = relativePath
    ? resolve(session.rootPath, ...relativePath.split("/"))
    : session.rootPath;
  if (relativePath && !target.startsWith(`${session.rootPath}${sep}`)) {
    invalid(`path escapes operation root: ${displayLabel(relativePath)}`);
  }
  return target;
}

async function assertPathIdentity(filesystem, path, expected, type, label) {
  const current = await bigintLstat(filesystem, path);
  assertType(current, type, label);
  assertIdentity(expected, current, label);
}

async function closeHandleBindings(bindings) {
  const failures = [];
  for (const binding of [...bindings].filter(Boolean).reverse()) {
    await binding.handle.close().catch((error) => failures.push(error));
  }
  if (failures.length > 0) {
    invalid("filesystem descriptor cleanup failed", { cause: failures[0] });
  }
}

export async function bindEvidenceRoot(root, options = {}, { create = false } = {}) {
  if (typeof root !== "string" || root.length === 0) invalid("evidence root is required");
  const filesystem = evidenceFilesystem(options);
  openFlags(filesystem, true);
  const rootPath = resolve(root);
  if (create) {
    try {
      await bigintLstat(filesystem, rootPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await filesystem.mkdir(rootPath, { mode: 0o700, recursive: true });
    }
  }

  let before;
  try {
    before = await bigintLstat(filesystem, rootPath);
  } catch (error) {
    if (error?.code === "ENOENT") invalid("evidence root does not exist", { cause: error });
    throw error;
  }
  assertType(before, "directory", "root");
  const handle = await filesystem.open(rootPath, openFlags(filesystem, true));
  try {
    const opened = await bigintFstat(handle);
    assertType(opened, "directory", "root");
    assertIdentity(before, opened, "root");
    await assertPathIdentity(filesystem, rootPath, opened, "directory", "root");
    return {
      filesystem,
      handle,
      rootIdentity: opened,
      rootPath,
    };
  } catch (error) {
    try {
      await closeHandleBindings([{ handle }]);
    } catch (cleanupError) {
      invalid("filesystem descriptor cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}

export async function closeEvidenceRoot(session) {
  await session.handle.close();
}

export async function assertEvidenceRootStable(session) {
  await assertPathIdentity(
    session.filesystem,
    session.rootPath,
    session.rootIdentity,
    "directory",
    "root",
  );
  const opened = await bigintFstat(session.handle);
  assertIdentity(session.rootIdentity, opened, "root");
}

async function closeBindings(bindings) {
  await closeHandleBindings(bindings);
}

async function bindDirectory(session, relativePath, expected) {
  const label = displayLabel(relativePath);
  const path = containedPath(session, relativePath);
  await assertEvidenceRootStable(session);
  const before = await bigintLstat(session.filesystem, path);
  assertType(before, "directory", label);
  if (expected) assertIdentity(expected, before, label);
  const handle = await session.filesystem.open(path, openFlags(session.filesystem, true));
  try {
    const opened = await bigintFstat(handle);
    assertType(opened, "directory", label);
    assertIdentity(before, opened, label);
    await assertPathIdentity(session.filesystem, path, opened, "directory", label);
    await assertEvidenceRootStable(session);
    return { handle, identity: opened, label, path };
  } catch (error) {
    try {
      await closeHandleBindings([{ handle }]);
    } catch (cleanupError) {
      invalid("filesystem descriptor cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}

async function bindAncestorDirectories(session, relativePath) {
  const parent = posix.dirname(relativePath);
  if (parent === ".") return [];
  const bindings = [];
  let current = "";
  try {
    for (const segment of parent.split("/")) {
      current = current ? `${current}/${segment}` : segment;
      bindings.push(await bindDirectory(session, current));
    }
    return bindings;
  } catch (error) {
    try {
      await closeBindings(bindings);
    } catch (cleanupError) {
      invalid("filesystem descriptor cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}

async function assertBindingsStable(session, bindings) {
  await assertEvidenceRootStable(session);
  for (const binding of bindings) {
    await assertPathIdentity(
      session.filesystem,
      binding.path,
      binding.identity,
      "directory",
      binding.label,
    );
    assertIdentity(binding.identity, await bigintFstat(binding.handle), binding.label);
  }
}

export async function readBoundDirectory(session, relativePath = "", expected) {
  if (!relativePath) {
    if (expected) assertIdentity(expected, session.rootIdentity, "root");
    await assertEvidenceRootStable(session);
    const entries = await session.filesystem.readdir(session.rootPath, { withFileTypes: true });
    await assertEvidenceRootStable(session);
    return { entries, identity: session.rootIdentity };
  }

  const ancestors = await bindAncestorDirectories(session, relativePath);
  let directory;
  try {
    directory = await bindDirectory(session, relativePath, expected);
    const entries = await session.filesystem.readdir(directory.path, { withFileTypes: true });
    await assertBindingsStable(session, [...ancestors, directory]);
    return { entries, identity: directory.identity };
  } finally {
    await closeBindings([...ancestors, directory]);
  }
}

export async function lstatBoundPath(session, relativePath) {
  const ancestors = await bindAncestorDirectories(session, relativePath);
  const label = displayLabel(relativePath);
  const path = containedPath(session, relativePath);
  try {
    await assertBindingsStable(session, ancestors);
    const before = await bigintLstat(session.filesystem, path);
    if (before.isSymbolicLink()) invalid(`symlink is not allowed: ${label}`);
    await assertBindingsStable(session, ancestors);
    const after = await bigintLstat(session.filesystem, path);
    if (after.isSymbolicLink()) invalid(`symlink is not allowed: ${label}`);
    assertIdentity(before, after, label);
    return after;
  } finally {
    await closeBindings(ancestors);
  }
}

async function openBoundRegular(session, relativePath, expected) {
  const ancestors = await bindAncestorDirectories(session, relativePath);
  const label = displayLabel(relativePath);
  const path = containedPath(session, relativePath);
  let handle;
  try {
    await assertBindingsStable(session, ancestors);
    const before = await bigintLstat(session.filesystem, path);
    assertType(before, "file", label);
    if (expected) assertIdentity(expected, before, label);
    handle = await session.filesystem.open(path, openFlags(session.filesystem, false));
    const opened = await bigintFstat(handle);
    assertType(opened, "file", label);
    assertIdentity(before, opened, label);
    await assertPathIdentity(session.filesystem, path, opened, "file", label);
    await assertBindingsStable(session, ancestors);
    return {
      ancestors,
      handle,
      identity: opened,
      label,
      path,
    };
  } catch (error) {
    try {
      await closeBindings([...ancestors, handle ? { handle } : undefined]);
    } catch (cleanupError) {
      invalid("filesystem descriptor cleanup failed", { cause: cleanupError });
    }
    throw error;
  }
}

async function assertRegularBindingStable(session, binding) {
  await assertPathIdentity(
    session.filesystem,
    binding.path,
    binding.identity,
    "file",
    binding.label,
  );
  assertIdentity(binding.identity, await bigintFstat(binding.handle), binding.label);
  await assertBindingsStable(session, binding.ancestors);
}

async function closeRegularBinding(binding) {
  await closeBindings([...binding.ancestors, binding]);
}

export async function readBoundRegularFile(session, relativePath, { expected, maxBytes } = {}) {
  const binding = await openBoundRegular(session, relativePath, expected);
  try {
    const size = Number(binding.identity.size);
    if (!Number.isSafeInteger(size) || size < 0) invalid("file size is not safely representable");
    if (maxBytes !== undefined && size > maxBytes) invalid("file size limit exceeded");
    const bytes = await binding.handle.readFile();
    if (maxBytes !== undefined && bytes.length > maxBytes) invalid("file size limit exceeded");
    if (bytes.length !== size) invalid(`file changed while being read: ${binding.label}`);
    await assertRegularBindingStable(session, binding);
    return { byteSize: size, bytes, identity: binding.identity };
  } finally {
    await closeRegularBinding(binding);
  }
}

export async function hashBoundRegularFile(session, relativePath, { expected } = {}) {
  const binding = await openBoundRegular(session, relativePath, expected);
  try {
    const size = Number(binding.identity.size);
    if (!Number.isSafeInteger(size) || size < 0) invalid("file size is not safely representable");
    const hash = createHash("sha256");
    const stream = binding.handle.createReadStream({ autoClose: false });
    let byteSize = 0;
    for await (const chunk of stream) {
      hash.update(chunk);
      byteSize += chunk.length;
    }
    if (byteSize !== size) invalid(`file changed while being hashed: ${binding.label}`);
    await assertRegularBindingStable(session, binding);
    return { byteSize, sha256: hash.digest("hex") };
  } finally {
    await closeRegularBinding(binding);
  }
}

async function assertBoundPathAbsent(session, relativePath) {
  await assertEvidenceRootStable(session);
  try {
    await lstatBoundPath(session, relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      await assertEvidenceRootStable(session);
      return;
    }
    throw error;
  }
  invalid(`generated output destination already exists: ${displayLabel(relativePath)}`);
}

export async function assertOwnedRegularPath(session, ownership) {
  let information;
  try {
    information = await lstatBoundPath(session, ownership.relativePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      invalid(`filesystem ownership changed or missing: ${displayLabel(ownership.relativePath)}`, {
        cause: error,
      });
    }
    throw error;
  }
  assertType(information, "file", displayLabel(ownership.relativePath));
  if (!sameIdentity(ownership.identity, information)) {
    invalid(`filesystem ownership changed: ${displayLabel(ownership.relativePath)}`);
  }
  await assertEvidenceRootStable(session);
  return information;
}

export async function removeOwnedRegularPath(session, ownership) {
  await assertOwnedRegularPath(session, ownership);
  await assertEvidenceRootStable(session);
  await session.filesystem.rm(containedPath(session, ownership.relativePath));
  await assertEvidenceRootStable(session);
  await assertBoundPathAbsent(session, ownership.relativePath);
}

export async function renameOwnedRegularPath(
  session,
  ownership,
  destinationRelativePath,
  onRenamed,
) {
  const sourceRelativePath = ownership.relativePath;
  await assertOwnedRegularPath(session, ownership);
  await assertBoundPathAbsent(session, destinationRelativePath);
  await assertEvidenceRootStable(session);
  await session.filesystem.rename(
    containedPath(session, sourceRelativePath),
    containedPath(session, destinationRelativePath),
  );
  ownership.relativePath = destinationRelativePath;
  onRenamed?.();
  await assertEvidenceRootStable(session);
  await assertOwnedRegularPath(session, ownership);
  await assertBoundPathAbsent(session, sourceRelativePath);
  return ownership;
}

export async function ensureBoundDirectory(session, relativePath) {
  let current = "";
  for (const segment of relativePath.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    try {
      const existing = await lstatBoundPath(session, current);
      assertType(existing, "directory", displayLabel(current));
      continue;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    const ancestors = await bindAncestorDirectories(session, current);
    try {
      await assertBindingsStable(session, ancestors);
      try {
        await session.filesystem.mkdir(containedPath(session, current), { mode: 0o700 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      const created = await bindDirectory(session, current);
      await closeBindings([created]);
      await assertBindingsStable(session, ancestors);
    } finally {
      await closeBindings(ancestors);
    }
  }
}

export async function installBoundFileIfMissing(session, relativePath, contents, validateExisting) {
  const parent = posix.dirname(relativePath);
  const parentBindings = await bindAncestorDirectories(session, relativePath);
  const target = containedPath(session, relativePath);
  const temporaryName = `${basename(relativePath)}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryRelativePath = parent === "." ? temporaryName : `${parent}/${temporaryName}`;
  const temporary = containedPath(session, temporaryRelativePath);
  let handle;
  let ownership;
  try {
    await assertBindingsStable(session, parentBindings);
    handle = await session.filesystem.open(temporary, "wx", 0o600);
    ownership = {
      identity: await bigintFstat(handle),
      relativePath: temporaryRelativePath,
    };
    assertType(ownership.identity, "file", basename(temporary));
    await handle.writeFile(contents);
    await handle.sync();
    ownership.identity = await bigintFstat(handle);
    await assertBindingsStable(session, parentBindings);
    try {
      await session.filesystem.link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (["ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(error?.code)) {
          invalid(
            "atomic no-clobber installation is unavailable; use a filesystem with hard-link support",
            { cause: error },
          );
        }
        throw error;
      }
      await handle.close();
      handle = undefined;
      await removeOwnedRegularPath(session, ownership);
      ownership = undefined;
      await validateExisting();
      return false;
    }
    await assertBindingsStable(session, parentBindings);
    const installed = await openBoundRegular(session, relativePath, ownership.identity);
    await closeRegularBinding(installed);
    await handle.close();
    handle = undefined;
    await removeOwnedRegularPath(session, ownership);
    return true;
  } catch (error) {
    const cleanupFailures = [];
    if (handle) {
      if (!ownership) {
        const identity = await bigintFstat(handle).catch(() => undefined);
        if (identity) ownership = { identity, relativePath: temporaryRelativePath };
      }
      await handle.close().catch((cleanupError) => cleanupFailures.push(cleanupError));
      handle = undefined;
    }
    if (ownership) {
      await removeOwnedRegularPath(session, ownership).catch((cleanupError) =>
        cleanupFailures.push(cleanupError),
      );
    }
    if (cleanupFailures.length > 0) {
      invalid("owned temporary or descriptor cleanup failed; manual recovery is required", {
        cause: cleanupFailures[0],
      });
    }
    throw error;
  } finally {
    await closeBindings(parentBindings);
  }
}
