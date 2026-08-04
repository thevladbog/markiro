import process from "node:process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function isMainModule(moduleUrl, argv = process.argv) {
  const entry = Array.isArray(argv) ? argv[1] : undefined;
  return (
    typeof entry === "string" &&
    entry.length > 0 &&
    pathToFileURL(resolve(entry)).href === moduleUrl
  );
}
