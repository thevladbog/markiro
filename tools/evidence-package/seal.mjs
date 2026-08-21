import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.mjs";
import { sealEvidencePackage } from "./evidence-package.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli({
    action: ([root]) => sealEvidencePackage(root),
    args: process.argv.slice(2),
    command: "evidence:seal",
    expectedArgs: 1,
    formatSuccess: (result) =>
      `Sealed evidence package: ${result.artifactCount} artifacts, ${result.checksumCount} checksums\n`,
    usage: "usage: evidence:seal <root>",
  });
}
