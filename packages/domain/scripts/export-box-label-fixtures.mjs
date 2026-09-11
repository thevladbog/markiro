// Writes the SSCC and box-label-date fixtures the handheld's Kotlin tests
// consume. Runs against the built package (`pnpm --filter @markiro/domain
// fixtures:box-labels` builds first) because the sources use `.js` import
// specifiers that Node's type stripping does not rewrite.
//
// Each case names the zone it needs; `localIsoDate` resolves a stored UTC
// instant against the ambient one, so an unpinned run would write a fixture that
// only reproduces on the machine that generated it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { buildBoxLabelFixtures } = await import("../dist/labels/box-label-fixtures.js");

/** Node re-reads process.env.TZ for every Date operation after the assignment. */
function inZone(tz, build) {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    return build();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

const target = fileURLToPath(
  new URL("../../../apps/handheld/app/src/test/resources/box-label-fixtures.json", import.meta.url),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildBoxLabelFixtures(inZone), null, 2) + "\n");
console.log(`wrote ${target}`);
