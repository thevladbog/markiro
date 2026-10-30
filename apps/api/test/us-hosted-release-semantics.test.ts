import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DOCUMENT_BYTES, LIBRARIES } from "../src/deployment/us-request-build-document";
import {
  assertHostedLibraryMetadata,
  assertHostedWorkspaceMetadata,
  assertHostedWorkspaceResolutions,
  assertHostedStaticReferences,
  assertHostedMigrationReferences,
} from "../src/deployment/us-hosted-release-semantics";

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const workspace = (target: unknown, name = "@markiro/db") =>
  bytes({ name, exports: { ".": target } });
const refuse = (operation: () => void) => expect(operation).toThrow("us_hosted_release_invalid");

describe("retained protected metadata semantics (not release authority)", () => {
  it("accepts every exact installed library identity", () => {
    for (const [name, version] of Object.entries(LIBRARIES)) {
      const key = name as keyof typeof LIBRARIES;
      expect(() => assertHostedLibraryMetadata(key, bytes({ name, version }))).not.toThrow();
      refuse(() => assertHostedLibraryMetadata(key, bytes({ name, version: "0.0.0" })));
      refuse(() => assertHostedLibraryMetadata(key, bytes({ name: "foreign", version })));
    }
  });

  it("rejects malformed, non-UTF8 and oversized retained metadata", () => {
    for (const input of [Buffer.from("{"), Buffer.from([0xff]), Buffer.alloc(DOCUMENT_BYTES + 1)]) {
      refuse(() => assertHostedLibraryMetadata("fflate", input));
      refuse(() => assertHostedWorkspaceMetadata("@markiro/db", input));
    }
  });

  it("accepts the same root export and recursive runtime branches as the local primitive", () => {
    for (const target of [
      "./dist/index.js",
      { default: "./dist/index.js", types: "./dist/index.d.ts" },
      {
        import: { default: "./dist/index.js" },
        require: "./dist/index.js",
        default: "./dist/index.js",
      },
    ]) {
      expect(() => assertHostedWorkspaceMetadata("@markiro/db", workspace(target))).not.toThrow();
    }
  });

  it("refuses foreign manifests and every escaping or incomplete runtime branch", () => {
    for (const target of [
      "../dist/index.js",
      "./dist/other.js",
      null,
      [],
      { require: "./dist/index.js" },
      { default: "./dist/index.js", import: "./stale.js" },
      { default: "./dist/index.js", import: { require: "./dist/index.js" } },
    ])
      refuse(() => assertHostedWorkspaceMetadata("@markiro/db", workspace(target)));
    refuse(() =>
      assertHostedWorkspaceMetadata("@markiro/db", workspace("./dist/index.js", "foreign")),
    );
  });

  it("preserves the original recursive export-rule bytes exactly", () => {
    const source = (name: string) =>
      readFileSync(resolve(__dirname, `../src/deployment/${name}.ts`), "utf8");
    const rule = (text: string) => {
      const start = text.indexOf("    function checkExport(value: unknown): void {");
      const end = text.indexOf("    checkExport(", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    expect(
      createHash("sha256").update(source("us-request-build-verification-core")).digest("hex"),
    ).toBe("e3cb42c57a82392b353c4b1256faa0f3009c308081ec16b490e14fcabd5c2dcf");
    expect(rule(source("us-hosted-release-semantics"))).toBe(
      rule(source("us-request-build-verification-core")),
    );
  });
});

describe("complete canonical workspace resolution evidence", () => {
  const files = [
    { tree: "api" as const, path: "main.js", byteSize: 1, sha256: "a".repeat(64) },
    { tree: "api" as const, path: "same.js", byteSize: 1, sha256: "b".repeat(64) },
    { tree: "contracts" as const, path: "index.js", byteSize: 1, sha256: "c".repeat(64) },
    { tree: "db" as const, path: "index.js", byteSize: 1, sha256: "d".repeat(64) },
    { tree: "domain" as const, path: "index.js", byteSize: 1, sha256: "e".repeat(64) },
  ];
  const evidence = [
    ...["db", "domain", "platform-contracts"].map((pkg) => ({
      tree: "api",
      directory: ".",
      name: `@markiro/${pkg}`,
      owner: `/app/packages/${pkg}`,
      entry: `/app/packages/${pkg}/dist/index.js`,
    })),
    {
      tree: "contracts",
      directory: ".",
      name: "@markiro/domain",
      owner: "/app/packages/domain",
      entry: "/app/packages/domain/dist/index.js",
    },
  ];
  it("requires the exact checked owner and entry for each distinct importer directory", () => {
    expect(() => assertHostedWorkspaceResolutions({ files }, evidence)).not.toThrow();
  });
  it("rejects a foreign export owner even if its entry aliases checked bytes", () => {
    const altered = evidence.map((record, index) =>
      index === 0 ? { ...record, owner: "/app/node_modules/.pnpm/foreign" } : record,
    );
    refuse(() => assertHostedWorkspaceResolutions({ files }, altered));
  });
  it("rejects missing, duplicate, unexpected and stale entry resolutions", () => {
    for (const altered of [
      evidence.slice(1),
      [...evidence, ...evidence.slice(0, 1)],
      [...evidence, ...evidence.slice(0, 1).map((record) => ({ ...record, directory: "extra" }))],
      evidence.map((record) => ({
        ...record,
        entry: record.entry.replace("index.js", "stale.js"),
      })),
    ])
      refuse(() => assertHostedWorkspaceResolutions({ files }, altered));
    refuse(() =>
      assertHostedWorkspaceResolutions(
        {
          files: [
            ...files,
            ...files.slice(0, 1).map((file) => ({ ...file, path: "nested/other.js" })),
          ],
        },
        evidence,
      ),
    );
  });
  it("refuses resolution evidence when the checked tree lacks its entry bytes", () => {
    refuse(() =>
      assertHostedWorkspaceResolutions(
        { files: files.filter((file) => file.tree !== "db") },
        evidence,
      ),
    );
  });
});

describe("retained static and migration references", () => {
  const staticFiles = [
    "apps/admin/dist-us/index.html",
    "apps/admin/dist-us/assets/main.js",
    "apps/admin/dist-us/assets/main.css",
  ];
  const staticDocument = {
    "index.html": { file: "assets/main.js", isEntry: true, css: ["assets/main.css"] },
  };
  it("binds Vite output references to the checked static inventory", () => {
    expect(() => assertHostedStaticReferences(bytes(staticDocument), staticFiles)).not.toThrow();
    refuse(() => assertHostedStaticReferences(bytes(staticDocument), staticFiles.slice(0, 2)));
    for (const file of ["../escape.js", "https://external.invalid/main.js", "/assets/main.js"]) {
      refuse(() =>
        assertHostedStaticReferences(bytes({ "index.html": { file, isEntry: true } }), staticFiles),
      );
    }
    refuse(() =>
      assertHostedStaticReferences(
        bytes({ "index.html": { ...staticDocument["index.html"], imports: ["missing"] } }),
        staticFiles,
      ),
    );
  });
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
  };
  const sql = ["packages/db/migrations/0000_initial.sql"];
  it("requires every migration SQL and exactly one ordered journal reference", () => {
    expect(() => assertHostedMigrationReferences(bytes(journal), sql)).not.toThrow();
    refuse(() => assertHostedMigrationReferences(bytes(journal), []));
    refuse(() =>
      assertHostedMigrationReferences(bytes(journal), [
        ...sql,
        "packages/db/migrations/unlisted.sql",
      ]),
    );
    refuse(() =>
      assertHostedMigrationReferences(
        bytes({ ...journal, entries: [...journal.entries, ...journal.entries] }),
        sql,
      ),
    );
    refuse(() =>
      assertHostedMigrationReferences(
        bytes({ ...journal, entries: [{ ...journal.entries[0], tag: "../escape" }] }),
        sql,
      ),
    );
  });
});
