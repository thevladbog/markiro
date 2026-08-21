import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EvidencePackageError, verifyEvidencePackage } from "./evidence-package.mjs";

function invalid(message) {
  throw new EvidencePackageError(message);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  if (args.length !== 1) invalid("usage: evidence:verify <root>");
  const result = await verifyEvidencePackage(args[0]);
  process.stdout.write(`Verified evidence package: ${result.checkedCount} files\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected failure";
    process.stderr.write(`evidence:verify: ${message}\n`);
    process.exitCode = 1;
  }
}
