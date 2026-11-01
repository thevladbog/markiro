import { createHash } from "node:crypto";
import { posix } from "node:path";
import { canonicalExportDigest } from "@markiro/domain";
import { DOCUMENT_BYTES, FILE_BYTES, LIBRARIES, documentSchema } from "./us-request-build-document";
import {
  parseUsHostedReleaseManifest,
  type UnverifiedUsHostedReleaseManifest,
} from "./us-hosted-release-manifest";
import type { UsHostedReleaseFiles } from "./us-hosted-release-files";
import {
  assertHostedLibraryMetadata,
  assertHostedWorkspaceMetadata,
  assertHostedWorkspaceResolutions,
  assertHostedStaticReferences,
  assertHostedMigrationReferences,
  type UsHostedWorkspaceResolution,
} from "./us-hosted-release-semantics";

const invalid = () => new Error("us_hosted_release_invalid");
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const text = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);

/** Unverified facts only: no private registration, authority, final fence or reader ownership. */
export type UsHostedPackageFacts = Readonly<{
  manifest: UnverifiedUsHostedReleaseManifest;
  descriptorDigest: string;
  inventoryDigest: string;
}>;

/** Each fixed public issuer owns its reader and fences ALL reads before private issuance. */
export async function verifyUsHostedPackage(
  files: UsHostedReleaseFiles,
  expectations: Readonly<{ sourceSha: string; manifestSha256: string }>,
): Promise<UsHostedPackageFacts> {
  try {
    const manifestBytes = await files.read("us-synthetic-release.json", DOCUMENT_BYTES);
    const manifest = parseUsHostedReleaseManifest(text(manifestBytes));
    if (
      digest(manifestBytes) !== expectations.manifestSha256 ||
      manifest.build.gitSha !== expectations.sourceSha
    )
      throw invalid();
    const descriptorBytes = await files.read(manifest.requestBuildDescriptor.path, DOCUMENT_BYTES);
    const descriptor = documentSchema.parse(JSON.parse(text(descriptorBytes)));
    const descriptorDigest = canonicalExportDigest(descriptor);
    if (
      digest(descriptorBytes) !== manifest.requestBuildDescriptor.sha256 ||
      descriptorDigest !== manifest.requestBuildDescriptor.digest ||
      descriptor.build.dirty ||
      canonicalExportDigest(descriptor.build) !== canonicalExportDigest(manifest.build) ||
      descriptor.lockfileSha256 !== digest(await files.read("pnpm-lock.yaml", FILE_BYTES))
    )
      throw invalid();
    const treeRoots = {
      api: "apps/api/dist/",
      contracts: "packages/platform-contracts/dist/",
      db: "packages/db/dist/",
      domain: "packages/domain/dist/",
    } as const;
    const described = new Map(
      descriptor.files.map((file) => [treeRoots[file.tree] + file.path, file]),
    );
    const actualTrees = manifest.files.filter(
      (file) =>
        file.path !== manifest.requestBuildDescriptor.path &&
        Object.values(treeRoots).some((root) => file.path.startsWith(root)),
    );
    if (described.size !== actualTrees.length) throw invalid();
    for (const file of actualTrees) {
      const expected = described.get(file.path);
      if (!expected || expected.byteSize !== file.byteSize || expected.sha256 !== file.sha256)
        throw invalid();
    }
    // Per-capture fences cover records acquired so far. Collect resolution facts
    // before bulk acquisition; they remain non-authoritative until every byte
    // hash and the complete final fence below succeeds on this same reader.
    for (const name of ["@react-pdf/renderer", "write-excel-file", "fflate"] as const) {
      const captured = await files.capturePackage(manifest.entrypoints.api, name);
      assertHostedLibraryMetadata(name, captured.metadata);
    }
    if (canonicalExportDigest(descriptor.libraries) !== canonicalExportDigest(LIBRARIES))
      throw invalid();
    const packages = [
      ["@markiro/db", "db"],
      ["@markiro/domain", "domain"],
      ["@markiro/platform-contracts", "contracts"],
    ] as const;
    for (const [name, tree] of packages) {
      assertHostedWorkspaceMetadata(
        name,
        await files.read(treeRoots[tree].replace(/dist\/$/, "package.json"), DOCUMENT_BYTES),
      );
    }
    const resolutions: UsHostedWorkspaceResolution[] = [];
    const directories = new Set<string>();
    for (const file of descriptor.files) {
      if ((file.tree !== "api" && file.tree !== "contracts") || !file.path.endsWith(".js"))
        continue;
      const directory = posix.dirname(file.path);
      const key = file.tree + "/" + directory;
      if (directories.has(key)) continue;
      directories.add(key);
      for (const name of [
        "@markiro/db",
        "@markiro/domain",
        "@markiro/platform-contracts",
      ] as const) {
        if (file.tree === "contracts" && name !== "@markiro/domain") continue;
        const captured = await files.capturePackage(treeRoots[file.tree] + file.path, name);
        assertHostedWorkspaceMetadata(name, captured.metadata);
        resolutions.push({
          tree: file.tree,
          directory,
          name,
          owner: captured.owner,
          entry: captured.entry,
        });
      }
    }
    assertHostedWorkspaceResolutions(descriptor, resolutions);
    const inventory = await files.inventory();
    if (
      inventory.length !== manifest.files.length ||
      inventory.some((path, index) => path !== manifest.files[index]?.path)
    )
      throw invalid();
    for (const file of manifest.files) {
      const bytes = await files.read(file.path, FILE_BYTES);
      if (bytes.length !== file.byteSize || digest(bytes) !== file.sha256) throw invalid();
    }
    assertHostedStaticReferences(
      await files.read("apps/admin/dist-us/.vite/manifest.json", DOCUMENT_BYTES),
      inventory,
    );
    assertHostedMigrationReferences(
      await files.read("packages/db/migrations/meta/_journal.json", DOCUMENT_BYTES),
      inventory,
    );
    if (
      manifest.files.some(
        (file) =>
          file.path.startsWith("packages/db/migrations/") &&
          file.path.endsWith(".sql") &&
          !file.byteSize,
      )
    )
      throw invalid();
    return Object.freeze({
      manifest,
      descriptorDigest,
      inventoryDigest: canonicalExportDigest(manifest.files),
    });
  } catch {
    throw invalid();
  }
}
