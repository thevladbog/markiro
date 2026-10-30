import { z } from "zod";
import {
  DOCUMENT_BYTES,
  LIBRARIES,
  safePath,
  type UsRequestBuildDocument,
} from "./us-request-build-document";

const invalid = () => new Error("us_hosted_release_invalid");

/** Semantic checks only: callers must acquire and retain protected bytes first. */
function metadata(bytes: Buffer): unknown {
  if (bytes.length > DOCUMENT_BYTES) throw invalid();
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
}

export function assertHostedLibraryMetadata(name: keyof typeof LIBRARIES, bytes: Buffer): void {
  try {
    const parsed = z.object({ name: z.string(), version: z.string() }).parse(metadata(bytes));
    if (parsed.name !== name || parsed.version !== LIBRARIES[name]) throw invalid();
  } catch {
    throw invalid();
  }
}

export function assertHostedWorkspaceMetadata(
  name: "@markiro/db" | "@markiro/domain" | "@markiro/platform-contracts",
  bytes: Buffer,
): void {
  try {
    const parsed = z
      .object({ name: z.literal(name), exports: z.record(z.string(), z.unknown()) })
      .parse(metadata(bytes));
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
    checkExport(parsed.exports["."]);
  } catch {
    throw invalid();
  }
}

/** Canonical facts only; this type is not an admission token or protected-reader substitute. */
export type UsHostedWorkspaceResolution = Readonly<{
  tree: string;
  directory: string;
  name: string;
  owner: string;
  entry: string;
}>;

export function assertHostedWorkspaceResolutions(
  document: Pick<UsRequestBuildDocument, "files">,
  resolutions: ReadonlyArray<UsHostedWorkspaceResolution>,
): void {
  const packages = {
    "@markiro/db": "/app/packages/db",
    "@markiro/domain": "/app/packages/domain",
    "@markiro/platform-contracts": "/app/packages/platform-contracts",
  };
  for (const tree of ["db", "domain", "contracts"]) {
    if (!document.files.some((file) => file.tree === tree && file.path === "index.js"))
      throw invalid();
  }
  const expected = new Map<string, string>();
  for (const file of document.files) {
    if ((file.tree !== "api" && file.tree !== "contracts") || !file.path.endsWith(".js")) continue;
    const separator = file.path.lastIndexOf("/");
    const directory = separator === -1 ? "." : file.path.slice(0, separator);
    for (const [name, owner] of Object.entries(packages)) {
      if (file.tree === "contracts" && name !== "@markiro/domain") continue;
      expected.set(JSON.stringify([file.tree, directory, name]), owner);
    }
  }
  const seen = new Set<string>();
  for (const record of resolutions) {
    const key = JSON.stringify([record.tree, record.directory, record.name]);
    const owner = expected.get(key);
    if (
      owner === undefined ||
      seen.has(key) ||
      record.owner !== owner ||
      record.entry !== `${owner}/dist/index.js`
    )
      throw invalid();
    seen.add(key);
  }
  if (seen.size !== expected.size) throw invalid();
}

export function assertHostedStaticReferences(
  bytes: Buffer,
  inventory: ReadonlyArray<string>,
): void {
  try {
    const entry = z.object({
      file: safePath,
      isEntry: z.boolean().optional(),
      css: z.array(safePath).optional(),
      assets: z.array(safePath).optional(),
      imports: z.array(z.string()).optional(),
      dynamicImports: z.array(z.string()).optional(),
    });
    const manifest = z.record(z.string(), entry).parse(metadata(bytes));
    if (
      manifest["index.html"]?.isEntry !== true ||
      !inventory.includes("apps/admin/dist-us/index.html")
    )
      throw invalid();
    const paths = new Set(inventory);
    for (const value of Object.values(manifest)) {
      for (const path of [value.file, ...(value.css ?? []), ...(value.assets ?? [])]) {
        if (!paths.has("apps/admin/dist-us/" + path)) throw invalid();
      }
      for (const key of [...(value.imports ?? []), ...(value.dynamicImports ?? [])]) {
        if (!Object.hasOwn(manifest, key)) throw invalid();
      }
    }
  } catch {
    throw invalid();
  }
}

export function assertHostedMigrationReferences(
  bytes: Buffer,
  inventory: ReadonlyArray<string>,
): void {
  try {
    const journal = z
      .object({
        version: z.literal("7"),
        dialect: z.literal("postgresql"),
        entries: z
          .array(
            z
              .object({
                idx: z.number().int().nonnegative(),
                version: z.literal("7"),
                when: z.number().int().nonnegative(),
                tag: z.string().regex(/^[A-Za-z0-9_-]+$/),
                breakpoints: z.boolean(),
              })
              .strict(),
          )
          .min(1)
          .max(10_000),
      })
      .strict()
      .parse(metadata(bytes));
    const expected = new Set<string>();
    for (const [index, entry] of journal.entries.entries()) {
      const path = `packages/db/migrations/${entry.tag}.sql`;
      if (entry.idx !== index || expected.has(path)) throw invalid();
      expected.add(path);
    }
    const actual = inventory.filter(
      (path) => path.startsWith("packages/db/migrations/") && path.endsWith(".sql"),
    );
    if (actual.length !== expected.size || actual.some((path) => !expected.has(path)))
      throw invalid();
  } catch {
    throw invalid();
  }
}
