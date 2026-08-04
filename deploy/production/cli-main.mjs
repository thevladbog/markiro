import { realpathSync } from "node:fs";
import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl, argv = process.argv, canonicalize = realpathSync) {
  const entry = Array.isArray(argv) ? argv[1] : undefined;
  if (typeof entry !== "string" || entry.length === 0) return false;
  let canonicalEntry;
  try {
    canonicalEntry = canonicalize(resolve(entry));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
  return pathToFileURL(canonicalEntry).href === moduleUrl;
}
