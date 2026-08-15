import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyArtifactManifest } from "../../packages/legal-documents/dist/cli/verify-artifacts.js";

import { isMainModule } from "./cli-main.mjs";

export async function verifyPublishedLegalArtifacts(rootArgument) {
  if (typeof rootArgument !== "string" || rootArgument.length === 0)
    throw new Error("legal artifact root is required");
  const rootDir = path.resolve(rootArgument);
  const manifestPath = path.join(rootDir, "artifacts.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!Array.isArray(manifest)) throw new Error("legal artifact manifest must be an array");
  const pdfaValidatedFiles = new Set(
    manifest
      .filter((entry) => entry?.kind === "pdfa-2b" && typeof entry.fileName === "string")
      .map((entry) => entry.fileName),
  );
  return verifyArtifactManifest({ rootDir, manifestPath, pdfaValidatedFiles });
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    process.stderr.write("Usage: node verify-legal-artifacts.mjs <artifact-root>\n");
    process.exitCode = 1;
  } else {
    verifyPublishedLegalArtifacts(args[0])
      .then((artifacts) => {
        process.stdout.write(`Verified ${artifacts.length} committed legal artifacts\n`);
      })
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
  }
}
