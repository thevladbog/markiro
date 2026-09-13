import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildValidationReprocessingFixtures } from "../dist/validation-reprocessing-fixtures.js";

const target = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/validation-reprocessing-fixtures.json",
    import.meta.url,
  ),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildValidationReprocessingFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
