// Writes the product-label fixtures the handheld's Kotlin tests consume. Runs
// against the built package (`pnpm --filter @markiro/domain
// fixtures:product-labels` builds first) because the sources use `.js` import
// specifiers that Node's type stripping does not rewrite.
//
// Unlike the box-label fixtures, nothing here reads the clock or the ambient
// time zone: every instant in a case is a literal, so the output is the same on
// any machine without pinning anything.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { buildProductLabelFixtures } = await import("../dist/product-labels/fixtures.js");

const target = fileURLToPath(
  new URL(
    "../../../apps/handheld/app/src/test/resources/product-label-fixtures.json",
    import.meta.url,
  ),
);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(buildProductLabelFixtures(), null, 2) + "\n");
console.log(`wrote ${target}`);
