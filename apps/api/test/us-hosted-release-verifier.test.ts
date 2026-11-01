import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import {
  assertUsHostedRelease,
  disposeUsHostedRelease,
  usHostedReleaseIdentity,
  verifyUsHostedRelease,
} from "../src/deployment/us-hosted-release-verifier";

it("refuses structural release imitations at every authority accessor", () => {
  for (const value of [null, undefined, {}, Object.freeze({ service: "api", disposed: false })]) {
    expect(() => assertUsHostedRelease(value)).toThrow("us_hosted_release_invalid");
    expect(() => usHostedReleaseIdentity(value)).toThrow("us_hosted_release_invalid");
    expect(() => disposeUsHostedRelease(value)).toThrow("us_hosted_release_invalid");
  }
});
it("requires the fixed installed package and never admits this source checkout", async () => {
  await expect(verifyUsHostedRelease("api")).rejects.toThrow("us_hosted_release_invalid");
});

it("restores the complete pre-extraction issuer by exact literal inverse", () => {
  const issuer = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-release-verifier.ts"),
    "utf8",
  );
  const checker = readFileSync(
    resolve(__dirname, "../src/deployment/us-hosted-package-verification.ts"),
    "utf8",
  );
  const begin =
    '    const manifestBytes = await files.read("us-synthetic-release.json", DOCUMENT_BYTES);\n';
  const end = "    return Object.freeze({\n";
  expect(checker.split(begin)).toHaveLength(2);
  expect(checker.split(end)).toHaveLength(2);
  const block = checker
    .slice(checker.indexOf(begin), checker.indexOf(end))
    .replaceAll("expectations.manifestSha256", "config.release.manifestSha256")
    .replaceAll("expectations.sourceSha", "config.release.sourceSha");
  const call =
    "    const { manifest, descriptorDigest, inventoryDigest } = await verifyUsHostedPackage(files, {\n      sourceSha: config.release.sourceSha,\n      manifestSha256: config.release.manifestSha256,\n    });\n";
  expect(issuer.split(call)).toHaveLength(2);
  let restored =
    'import { createHash } from "node:crypto";\nimport { posix } from "node:path";\nimport { canonicalExportDigest } from "@markiro/domain";\nimport type { UsExportBuildIdentity } from "@markiro/platform-contracts";\nimport { DOCUMENT_BYTES, FILE_BYTES, LIBRARIES, documentSchema } from "./us-request-build-document";\nimport { parseUsHostedReleaseManifest } from "./us-hosted-release-manifest";\nimport {\n  parseUsSyntheticHostedConfig,\n  type UsSyntheticHostedConfig,\n  type UsSyntheticHostedService,\n} from "./us-synthetic-hosted-config";\nimport { UsHostedReleaseFiles } from "./us-hosted-release-files";\nimport {\n  assertHostedLibraryMetadata,\n  assertHostedWorkspaceMetadata,\n  assertHostedWorkspaceResolutions,\n  assertHostedStaticReferences,\n  assertHostedMigrationReferences,\n  type UsHostedWorkspaceResolution,\n} from "./us-hosted-release-semantics";\n\n' +
    issuer.slice(issuer.indexOf("const invalid ="));
  restored = restored.replace(
    'const invalid = () => new Error("us_hosted_release_invalid");\n',
    'const invalid = () => new Error("us_hosted_release_invalid");\nconst digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");\n',
  );
  restored = restored
    .replace(call, block)
    .replace(
      "      inventoryDigest,\n",
      "      inventoryDigest: canonicalExportDigest(manifest.files),\n",
    );
  expect(createHash("sha256").update(restored).digest("hex")).toBe(
    "40c48394dcb403b937f829114ff6bcf696c9d6a189443b20840855f6bee87033",
  );
});
