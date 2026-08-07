import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function canonicalPath(path, canonicalize) {
  try {
    return canonicalize(path);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return undefined;
    throw error;
  }
}

export function isMainModule(moduleUrl, argv = process.argv, canonicalize = realpathSync) {
  const entry = Array.isArray(argv) ? argv[1] : undefined;
  if (typeof entry !== "string" || entry.length === 0) return false;
  let modulePath;
  try {
    modulePath = fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
  const canonicalModule = canonicalPath(modulePath, canonicalize);
  if (canonicalModule === undefined) return false;
  const canonicalEntry = canonicalPath(resolve(entry), canonicalize);
  return canonicalEntry !== undefined && canonicalEntry === canonicalModule;
}
