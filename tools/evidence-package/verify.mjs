import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "./cli.mjs";
import { verifyEvidencePackage } from "./evidence-package.mjs";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli({
    action: ([root]) => verifyEvidencePackage(root),
    args: process.argv.slice(2),
    command: "evidence:verify",
    expectedArgs: 1,
    formatSuccess: (result) => `Verified evidence package: ${result.checkedCount} files\n`,
    usage: "usage: evidence:verify <root>",
  });
}
