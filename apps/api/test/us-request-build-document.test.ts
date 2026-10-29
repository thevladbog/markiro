import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { documentSchema, FILE_BYTES, LIBRARIES } from "../src/deployment/us-request-build-document";
const originalSha = "5166ec5a0e52ea6bffc93aac54ccb567a615e6d5654c69a1c604592b090c228a";
const names = [
  "DOCUMENT_BYTES",
  "FILE_BYTES",
  "TOTAL_BYTES",
  "MAX_FILES",
  "LIBRARIES",
  "TREES",
  "DESCRIPTOR",
  "safePath",
  "documentSchema",
];
const prefix =
  'import {\n  usExportBuildIdentitySchema,\n  type UsExportBuildIdentity,\n} from "@markiro/platform-contracts";\nimport { z } from "zod";\n\n';
const imports =
  'import {\n  DOCUMENT_BYTES,\n  FILE_BYTES,\n  TOTAL_BYTES,\n  MAX_FILES,\n  LIBRARIES,\n  TREES,\n  DESCRIPTOR,\n  safePath,\n  documentSchema,\n  type UsRequestBuildDocument,\n} from "./us-request-build-document";\nexport type { UsRequestBuildDocument } from "./us-request-build-document";\n';
const read = (file: string) => readFileSync(resolve(__dirname, "../src/deployment", file), "utf8");
function restore(local: string, core: string) {
  expect(core.startsWith(prefix)).toBe(true);
  let block = core.slice(prefix.length);
  for (const name of names) {
    const exported = "export const " + name + " =";
    expect(block.split(exported)).toHaveLength(2);
    block = block.replace(exported, "const " + name + " =");
  }
  expect(local.split(imports)).toHaveLength(2);
  const anchor = "export type LoadedUsRequestBuildDescriptor";
  expect(local.split(anchor)).toHaveLength(2);
  const original = local.replace(imports, "").replace(anchor, block + anchor);
  expect(createHash("sha256").update(original).digest("hex")).toBe(originalSha);
}
it("restores the complete original guarded descriptor", () =>
  restore(read("us-request-build-descriptor.ts"), read("us-request-build-document.ts")));
it.each([
  ["32 * 1024 * 1024", "33 * 1024 * 1024"],
  ["4.6.1", "4.6.2"],
  ["key <= previous", "key < previous"],
])("rejects core mutation %s", (before, after) => {
  const core = read("us-request-build-document.ts");
  expect(core.includes(before)).toBe(true);
  expect(() =>
    restore(read("us-request-build-descriptor.ts"), core.replace(before, after)),
  ).toThrow();
});
it.each([
  ["loadUsDevelopmentEnv(source);", "void source;"],
  ["loaded.add(result);", "void result;"],
])("rejects loader authority mutation %s", (before, after) => {
  const local = read("us-request-build-descriptor.ts");
  expect(local.split(before)).toHaveLength(2);
  expect(() =>
    restore(local.replace(before, after), read("us-request-build-document.ts")),
  ).toThrow();
});
function fixture() {
  const hash = "a".repeat(64);
  const files = [
    { tree: "api", path: "main.js", byteSize: 1, sha256: hash },
    ...["IBMPlexSans-Regular.ttf", "IBMPlexSans-Bold.ttf"].map((name) => ({
      tree: "api",
      path: "modules/traceability/plans/assets/" + name,
      byteSize: 1,
      sha256: hash,
    })),
    ...["contracts", "db", "domain"].map((tree) => ({
      tree,
      path: "index.js",
      byteSize: 1,
      sha256: hash,
    })),
  ].sort((a, b) => (a.tree + "/" + a.path < b.tree + "/" + b.path ? -1 : 1));
  return {
    schemaVersion: 1,
    build: { apiVersion: "0.1.0", gitSha: "a".repeat(40), dirty: false },
    lockfileSha256: hash,
    libraries: { ...LIBRARIES },
    files,
  };
}
it("admits the existing complete expected inventory including dirty build metadata", () => {
  const value = fixture();
  expect(documentSchema.safeParse(value).success).toBe(true);
  value.build.dirty = true;
  expect(documentSchema.safeParse(value).success).toBe(true);
});
it.each([
  "unknown",
  "duplicate",
  "missing-font",
  "missing-tree",
  "self-descriptor",
  "oversize-file",
  "unsafe-path",
  "library",
  "hash",
])("preserves schema refusal %s", (kind) => {
  const value = fixture();
  if (kind === "unknown") {
    expect(documentSchema.safeParse({ ...value, unknown: true }).success).toBe(false);
    return;
  }
  const first = value.files[0];
  if (!first) throw new Error("Missing synthetic file");
  if (kind === "duplicate") value.files.splice(1, 0, { ...first });
  if (kind === "missing-font")
    value.files = value.files.filter((f) => !f.path.endsWith("Bold.ttf"));
  if (kind === "missing-tree") value.files = value.files.filter((f) => f.tree !== "db");
  if (kind === "self-descriptor") first.path = "us-request-build.json";
  if (kind === "oversize-file") first.byteSize = FILE_BYTES + 1;
  if (kind === "unsafe-path") first.path = "../escape";
  if (kind === "library") Object.assign(value.libraries, { fflate: "0.8.4" });
  if (kind === "hash") first.sha256 = "A".repeat(64);
  expect(documentSchema.safeParse(value).success).toBe(false);
});
