import { canonicalExportDigest } from "@markiro/domain";
import {
  usExportBuildIdentitySchema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loadUsDevelopmentEnv } from "./entry-policy";
import {
  DOCUMENT_BYTES,
  FILE_BYTES,
  TOTAL_BYTES,
  MAX_FILES,
  LIBRARIES,
  TREES,
  DESCRIPTOR,
  safePath,
  documentSchema,
  type UsRequestBuildDocument,
} from "./us-request-build-document";
export type { UsRequestBuildDocument } from "./us-request-build-document";

export type UsRequestBuildTree = "api" | "db" | "domain" | "contracts";
export type UsRequestBuildRoots = Readonly<{
  trees: Readonly<Record<UsRequestBuildTree, string>>;
  lockfile: string;
}>;
export type LoadedUsRequestBuildDescriptor = Readonly<{
  document: UsRequestBuildDocument;
  digest: string;
}>;
const loaded = new WeakSet<object>();
const invalid = () => new Error("us_request_build_invalid");

/** Fixed workspace layout; no environment-selected roots or descriptor path. */
function defaultRoots(): UsRequestBuildRoots {
  const root = resolve(__dirname, "../../../..");
  return {
    trees: {
      api: join(root, "apps/api/dist"),
      db: join(root, "packages/db/dist"),
      domain: join(root, "packages/domain/dist"),
      contracts: join(root, "packages/platform-contracts/dist"),
    },
    lockfile: join(root, "pnpm-lock.yaml"),
  };
}

/** Inspect only components inside the workspace; OS aliases above it are allowed. */
async function assertWorkspaceParents(roots: UsRequestBuildRoots): Promise<void> {
  const workspace = resolve(roots.trees.api, "../../..");
  if (!(await lstat(workspace)).isDirectory()) throw invalid();
  const canonicalWorkspace = await realpath(workspace);
  for (const path of [...Object.values(roots.trees), roots.lockfile]) {
    const absolute = resolve(path);
    const within = relative(workspace, absolute);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw invalid();
    let parent = workspace;
    for (const component of within.split(sep).slice(0, -1)) {
      parent = join(parent, component);
      // lstat never follows this component, unlike lstat of the final dist root.
      if (!(await lstat(parent)).isDirectory()) throw invalid();
    }
    if ((await realpath(dirname(absolute))) !== resolve(canonicalWorkspace, dirname(within)))
      throw invalid();
  }
}

async function readBounded(path: string, maximum: number): Promise<Buffer> {
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
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function installedLibraries(api: string): Promise<typeof LIBRARIES> {
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
async function assertWorkspaceResolution(
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

export async function captureUsRequestBuildDescriptor(
  build: UsExportBuildIdentity,
  roots: UsRequestBuildRoots,
): Promise<UsRequestBuildDocument> {
  try {
    const checkedBuild = usExportBuildIdentitySchema.parse(build);
    await assertWorkspaceParents(roots);
    const lock = await readBounded(roots.lockfile, FILE_BYTES);
    let total = lock.length;
    const files: z.infer<typeof documentSchema>["files"] = [];
    for (const tree of TREES) {
      const root = roots.trees[tree];
      if (!(await lstat(root)).isDirectory()) throw invalid();
      async function walk(relative: string): Promise<void> {
        for (const entry of (await readdir(join(root, relative))).sort()) {
          const path = relative ? `${relative}/${entry}` : entry;
          safePath.parse(path);
          const absolute = join(root, path);
          const stat = await lstat(absolute);
          if (stat.isSymbolicLink()) throw invalid();
          if (stat.isDirectory()) {
            await walk(path);
            continue;
          }
          if (!stat.isFile()) throw invalid();
          if (tree === "api" && path === DESCRIPTOR) continue;
          if (
            files.length >= MAX_FILES ||
            stat.size > FILE_BYTES ||
            total + stat.size > TOTAL_BYTES
          )
            throw invalid();
          const bytes = await readBounded(absolute, Math.min(FILE_BYTES, TOTAL_BYTES - total));
          total += bytes.length;
          files.push({ tree, path, byteSize: bytes.length, sha256: hash(bytes) });
        }
      }
      await walk("");
    }
    files.sort((a, b) => (`${a.tree}/${a.path}` < `${b.tree}/${b.path}` ? -1 : 1));
    const document = documentSchema.parse({
      schemaVersion: 1,
      build: checkedBuild,
      lockfileSha256: hash(lock),
      libraries: await installedLibraries(roots.trees.api),
      files,
    });
    if (Buffer.byteLength(JSON.stringify(document)) > DOCUMENT_BYTES) throw invalid();
    return document;
  } catch {
    throw invalid();
  }
}

export async function loadUsRequestBuildDescriptor(
  source: NodeJS.ProcessEnv,
  roots: UsRequestBuildRoots = defaultRoots(),
): Promise<LoadedUsRequestBuildDescriptor> {
  try {
    loadUsDevelopmentEnv(source);
    await assertWorkspaceParents(roots);
    const document = documentSchema.parse(
      JSON.parse(
        (await readBounded(join(roots.trees.api, DESCRIPTOR), DOCUMENT_BYTES)).toString("utf8"),
      ),
    );
    if (document.build.dirty) throw invalid();
    const captured = await captureUsRequestBuildDescriptor(document.build, roots);
    if (canonicalExportDigest(captured) !== canonicalExportDigest(document)) throw invalid();
    await assertWorkspaceResolution(roots, document);
    const immutable: UsRequestBuildDocument = Object.freeze({
      ...document,
      build: Object.freeze(document.build),
      libraries: Object.freeze(document.libraries),
      files: Object.freeze(document.files.map((file) => Object.freeze(file))),
    });
    const result = Object.freeze({ document: immutable, digest: canonicalExportDigest(immutable) });
    loaded.add(result);
    return result;
  } catch {
    throw invalid();
  }
}

export function assertLoadedUsRequestBuildDescriptor(value: LoadedUsRequestBuildDescriptor): void {
  if (!value || typeof value !== "object" || !loaded.has(value)) throw invalid();
}
