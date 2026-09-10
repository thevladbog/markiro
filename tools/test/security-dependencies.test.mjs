import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const lock = load(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"));

// Patched floors from the September 2026 GitHub Security triage. Check every
// resolved copy: a direct upgrade alone can leave an unsafe transitive copy.
const patched = {
  astro: "7.2.8", // GHSA-26w7-cxv4-gfx2, GHSA-376h-93r7-7g6f
  sharp: "0.35.4", // GHSA-rgj7-g3m4-5g8c
  next: "16.3.3", // GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36
  nodemailer: "9.1.1", // Includes GHSA-8m3c-c648-2xjj and the 9.1.0 parser fixes
  multer: "2.3.0", // GHSA-wc9g-mqfw-jrwm, qvfw-j98x-7q72, 535w-7cp7-47q4, qfvm-cv95-jqjf
  qs: "6.16.0", // GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g
  svgo: "4.1.0", // GHSA-4vpr-x523-8j87, GHSA-w27v-7q3p-w38r
};

for (const [name, minimum] of Object.entries(patched)) {
  test(`all resolved ${name} copies meet the reviewed security floor ${minimum}`, () => {
    const versions = Object.keys(lock.packages)
      .filter((key) => key.startsWith(`${name}@`))
      .map((key) => key.slice(name.length + 1));
    for (const version of versions) {
      assert.match(version, /^\d+\.\d+\.\d+$/, `review non-stable ${name}@${version}`);
      assert.ok(
        version.localeCompare(minimum, "en", { numeric: true }) >= 0,
        `${name}@${version} is below patched ${minimum}`,
      );
    }
  });
}
