import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { UsRequestBuildRoots } from "./us-request-build-descriptor";
import {
  DOCUMENT_BYTES,
  LIBRARIES,
  type UsRequestBuildDocument,
} from "./us-request-build-document";

const invalid = () => new Error("us_request_build_invalid");

export async function readBounded(path: string, maximum: number): Promise<Buffer> {
  // O_NOFOLLOW closes the lstat/open race for final path components.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw invalid();
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length !== stat.size) throw invalid();
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}
export const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export async function installedLibraries(api: string): Promise<typeof LIBRARIES> {
  const require = createRequire(resolve(api, "../package.json"));
  for (const [name, version] of Object.entries(LIBRARIES)) {
    // Resolve the same Node entry used by the XLSX writer, not a browser/root export.
    let directory = dirname(require.resolve(name === "write-excel-file" ? `${name}/node` : name));
    for (;;) {
      try {
        const metadata: unknown = JSON.parse(
          (await readBounded(join(directory, "package.json"), DOCUMENT_BYTES)).toString("utf8"),
        );
        const parsed = z.object({ name: z.string(), version: z.string() }).parse(metadata);
        if (parsed.name === name) {
          if (parsed.version !== version) throw invalid();
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.message === "us_request_build_invalid") throw error;
        // Package entry points can be nested; walk to their owning manifest.
      }
      const parent = dirname(directory);
      if (parent === directory) throw invalid();
      directory = parent;
    }
  }
  return LIBRARIES;
}

/** Bind the current API/CommonJS and contracts/ESM workspace imports to checked bytes. */
export async function assertWorkspaceResolution(
  roots: UsRequestBuildRoots,
  document: UsRequestBuildDocument,
): Promise<void> {
  const packages = {
    "@markiro/db": "db",
    "@markiro/domain": "domain",
    "@markiro/platform-contracts": "contracts",
  } as const;
  const entries = new Map<string, string>();
  for (const [name, tree] of Object.entries(packages)) {
    if (!document.files.some((file) => file.tree === tree && file.path === "index.js"))
      throw invalid();
    const metadata = z
      .object({ name: z.literal(name), exports: z.record(z.string(), z.unknown()) })
      .parse(
        JSON.parse(
          (await readBounded(join(roots.trees[tree], "../package.json"), DOCUMENT_BYTES)).toString(
            "utf8",
          ),
        ),
      );
    // require.resolve uses require conditions. Check all runtime branches too so an
    // ESM import condition cannot silently select bytes outside this root export.
    function checkExport(value: unknown): void {
      if (typeof value === "string") {
        if (value !== "./dist/index.js") throw invalid();
        return;
      }
      const branches = z.record(z.string(), z.unknown()).parse(value);
      if (!("default" in branches)) throw invalid();
      for (const [condition, target] of Object.entries(branches)) {
        if (condition !== "types") checkExport(target);
      }
    }
    checkExport(metadata.exports["."]);
    entries.set(name, await realpath(join(roots.trees[tree], "index.js")));
  }
  const checkedDirectories = new Set<string>();
  for (const file of document.files) {
    if ((file.tree !== "api" && file.tree !== "contracts") || !file.path.endsWith(".js")) continue;
    const importer = await realpath(join(roots.trees[file.tree], file.path));
    const directoryKey = `${file.tree}/${dirname(importer)}`;
    if (checkedDirectories.has(directoryKey)) continue;
    checkedDirectories.add(directoryKey);
    const require = createRequire(importer);
    for (const [name, entry] of entries) {
      if (file.tree === "contracts" && name !== "@markiro/domain") continue;
      let found = false;
      for (const modules of require.resolve.paths(name) ?? []) {
        const directory = join(modules, name);
        try {
          await lstat(directory);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
        // The package owning the export map must also be the checked package.
        // A foreign require entry may alias checked bytes while its import branch
        // still selects stale code; canonical entry equality alone cannot bind it.
        if ((await realpath(directory)) !== dirname(dirname(entry))) throw invalid();
        found = true;
        break;
      }
      if (!found) throw invalid();
      if ((await realpath(require.resolve(name))) !== entry) throw invalid();
    }
  }
}
