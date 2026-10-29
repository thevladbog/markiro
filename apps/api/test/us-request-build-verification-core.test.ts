import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import * as verification from "../src/deployment/us-request-build-verification-core";
import { captureUsRequestBuildDescriptor } from "../src/deployment/us-request-build-descriptor";
import { LIBRARIES } from "../src/deployment/us-request-build-document";
import { createUsRequestBuildFixture } from "./support/us-request-build-fixture";
const read = (file: string) => readFileSync(resolve(__dirname, "../src/deployment", file), "utf8");
const verificationPrefix =
  'import { createHash } from "node:crypto";\nimport { constants } from "node:fs";\nimport { lstat, open, realpath } from "node:fs/promises";\nimport { createRequire } from "node:module";\nimport { dirname, join, resolve } from "node:path";\nimport { z } from "zod";\nimport type { UsRequestBuildRoots } from "./us-request-build-descriptor";\nimport {\n  DOCUMENT_BYTES,\n  LIBRARIES,\n  type UsRequestBuildDocument,\n} from "./us-request-build-document";\n\nconst invalid = () => new Error("us_request_build_invalid");\n\n';
const verificationImport =
  'import {\n  readBounded,\n  hash,\n  installedLibraries,\n  assertWorkspaceResolution,\n} from "./us-request-build-verification-core";\n';
function restoreVerification(local: string, verification: string) {
  expect(verification.startsWith(verificationPrefix)).toBe(true);
  let block = verification.slice(verificationPrefix.length);
  for (const [before, after] of [
    ["export async function readBounded(", "async function readBounded("],
    ["export const hash =", "const hash ="],
    ["export async function installedLibraries(", "async function installedLibraries("],
    [
      "export async function assertWorkspaceResolution(",
      "async function assertWorkspaceResolution(",
    ],
  ]) {
    if (before === undefined || after === undefined) throw new Error("Missing inverse pair");
    expect(block.split(before)).toHaveLength(2);
    block = block.replace(before, after);
  }
  expect(local.split(verificationImport)).toHaveLength(2);
  let original = local.replace(verificationImport, "");
  const importsBefore = 'import { lstat, readdir, realpath } from "node:fs/promises";\n';
  const importsAfter =
    'import { createHash } from "node:crypto";\nimport { constants } from "node:fs";\nimport { lstat, open, readdir, realpath } from "node:fs/promises";\nimport { createRequire } from "node:module";\n';
  expect(original.split(importsBefore)).toHaveLength(2);
  original = original.replace(importsBefore, importsAfter);
  const typeOnly = 'import type { z } from "zod";';
  expect(original.split(typeOnly)).toHaveLength(2);
  original = original.replace(typeOnly, 'import { z } from "zod";');
  const documentImports = "  MAX_FILES,\n  TREES,";
  expect(original.split(documentImports)).toHaveLength(2);
  original = original.replace(documentImports, "  MAX_FILES,\n  LIBRARIES,\n  TREES,");
  const anchor = "export async function captureUsRequestBuildDescriptor(";
  expect(original.split(anchor)).toHaveLength(2);
  expect(block.endsWith("}\n")).toBe(true);
  original = original.replace(anchor, block + "\n" + anchor);
  expect(createHash("sha256").update(original).digest("hex")).toBe(
    "9410ad50591d7355a68ae580dacf4f1d1b7274ce6fc8c5ea1c4de944722fcf46",
  );
  return original;
}
it("restores the complete original guarded descriptor", () => {
  restoreVerification(
    read("us-request-build-descriptor.ts"),
    read("us-request-build-verification-core.ts"),
  );
});
it.each([
  ["constants.O_NOFOLLOW", "0"],
  ["await handle.close();", "void handle;"],
  ['value !== "./dist/index.js"', 'value !== "./dist/other.js"'],
  ["if (parsed.version !== version)", "if (false)"],
])("rejects changed byte/import primitive %s", (before, after) => {
  const core = read("us-request-build-verification-core.ts");
  expect(core.split(before)).toHaveLength(2);
  expect(() =>
    restoreVerification(read("us-request-build-descriptor.ts"), core.replace(before, after)),
  ).toThrow();
});
it("exports only the four non-authoritative internal primitives", () => {
  expect(Object.keys(verification).sort()).toEqual([
    "assertWorkspaceResolution",
    "hash",
    "installedLibraries",
    "readBounded",
  ]);
});
it("hashes exact bytes deterministically", () => {
  expect(verification.hash(Buffer.from("abc"))).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
it("reads a bounded file and refuses over-limit and symlink inputs", async () => {
  const fixture = await createUsRequestBuildFixture();
  try {
    const path = join(fixture.root, "bounded.bin");
    await writeFile(path, Buffer.from([0, 255, 1]));
    expect(await verification.readBounded(path, 3)).toEqual(Buffer.from([0, 255, 1]));
    await expect(verification.readBounded(path, 2)).rejects.toThrow("us_request_build_invalid");
    const link = join(fixture.root, "linked.bin");
    await symlink(path, link);
    await expect(verification.readBounded(link, 3)).rejects.toMatchObject({ code: "ELOOP" });
  } finally {
    await fixture.dispose();
  }
});
it("preserves pinned libraries and rejects a wrong version", async () => {
  const fixture = await createUsRequestBuildFixture();
  try {
    expect(await verification.installedLibraries(fixture.roots.trees.api)).toEqual(LIBRARIES);
    await fixture.setLibraryVersion("fflate", "0.0.0");
    await expect(verification.installedLibraries(fixture.roots.trees.api)).rejects.toThrow(
      "us_request_build_invalid",
    );
  } finally {
    await fixture.dispose();
  }
});
it("checks genuine workspace entry provenance and rejects a foreign package alias", async () => {
  const fixture = await createUsRequestBuildFixture();
  try {
    const document = await captureUsRequestBuildDescriptor(fixture.cleanBuild, fixture.roots);
    await verification.assertWorkspaceResolution(fixture.roots, document);
    const foreign = join(fixture.root, "foreign-domain");
    await mkdir(foreign);
    await writeFile(
      join(foreign, "package.json"),
      JSON.stringify({ name: "@markiro/domain", exports: { ".": "./index.js" } }),
    );
    await symlink(join(fixture.roots.trees.domain, "index.js"), join(foreign, "index.js"));
    const modules = join(fixture.api, "node_modules/@markiro");
    await mkdir(modules, { recursive: true });
    await symlink(foreign, join(modules, "domain"));
    await expect(verification.assertWorkspaceResolution(fixture.roots, document)).rejects.toThrow(
      "us_request_build_invalid",
    );
  } finally {
    await fixture.dispose();
  }
});
