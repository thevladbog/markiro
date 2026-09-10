// Writes the KM parse/verdict fixtures the handheld's Kotlin tests consume.
// Runs against the built package (`pnpm --filter @markiro/domain fixtures:km`
// builds first) because the sources use `.js` import specifiers that Node's
// type stripping does not rewrite.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildKmFixtures } from "../dist/gs1/km-fixtures.js";

const target = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/km-fixtures.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildKmFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
