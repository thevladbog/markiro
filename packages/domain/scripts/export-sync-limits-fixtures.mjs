// Writes the shared sync batch bounds the handheld's Kotlin SyncEngine
// hand-copies as literals. Runs against the built package
// (`pnpm --filter @markiro/domain fixtures:sync-limits` builds first) because
// the sources use `.js` import specifiers that Node's type stripping does not
// rewrite.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSyncLimitsFixtures } from "../dist/sync/limits-fixtures.js";

const target = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/sync-limits-fixtures.json",
    import.meta.url,
  ),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildSyncLimitsFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
