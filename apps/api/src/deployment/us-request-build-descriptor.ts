import {
  readBounded,
  hash,
  installedLibraries,
  assertWorkspaceResolution,
} from "./us-request-build-verification-core";
import { canonicalExportDigest } from "@markiro/domain";
import {
  usExportBuildIdentitySchema,
  type UsExportBuildIdentity,
} from "@markiro/platform-contracts";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { z } from "zod";
import { loadUsDevelopmentEnv } from "./entry-policy";
import {
  DOCUMENT_BYTES,
  FILE_BYTES,
  TOTAL_BYTES,
  MAX_FILES,
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
