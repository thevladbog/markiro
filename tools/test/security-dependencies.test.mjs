import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const lock = load(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"));

// Patched floors from the September and October 2026 GitHub Security triages.
// Check every resolved copy: a direct upgrade alone can leave an unsafe
// transitive copy.
const patched = {
  astro: "7.2.8", // GHSA-26w7-cxv4-gfx2, GHSA-376h-93r7-7g6f
  sharp: "0.35.5", // GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w
  next: "16.3.6", // GHSA-2xp9-vwfh-vxw4, GHSA-p293-qw3h-jr36, GHSA-vcvr-r3jv-pc5j
  // 10.0.9 also covers GHSA-prgh-xp8r-p3m5, v53p-9fqp-m79j, 8vvx-rff5-p5rq, 6vj9-mwq6-2f5v
  nodemailer: "10.0.9", // GHSA-8m3c-c648-2xjj, GHSA-g57g-f23g-4646
  // 2.4.0 also covers GHSA-wc9g-mqfw-jrwm, qvfw-j98x-7q72, 535w-7cp7-47q4, qfvm-cv95-jqjf
  multer: "2.4.0", // GHSA-3pph-fpjx-jg34
  qs: "6.16.0", // GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g
  svgo: "4.1.0", // GHSA-4vpr-x523-8j87, GHSA-w27v-7q3p-w38r
  "proxy-addr": "2.0.8", // GHSA-jqcg-44mw-7w3h
  "@vue/server-renderer": "3.5.42", // GHSA-g2v6-rqmx-r4w6
  // 5.9.3 also covers GHSA-mcm9-63f2-9j32, wf3x-273g-mvxv, x5rw-q4pp-hg5g, 4q55-j62x-fr9h, 9rgm-9g3h-6x36
  devalue: "5.9.3", // GHSA-j22f-vq7h-c4qm, GHSA-hx4r-w6wj-j8fg
  "fast-uri": "3.1.8", // GHSA-58mr-gqgx-xq4g, GHSA-qw65-cvwx-89v3, GHSA-hrr3-gc8f-f4qj
  "ip-address": "10.7.1", // GHSA-j6r3-76f7-8jcv, h3mg-xc3c-68pw, rpw4-54j3-4h4q, 2vr4-cq9g-pvrc
  "brace-expansion": "5.0.12", // GHSA-q2hr-2g5m-vwhr
  "engine.io": "6.6.10", // GHSA-2gc4-cqfq-p2gv
  undici: "7.29.1", // GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3 and seven lower advisories
  "js-yaml": "5.4.1", // GHSA-r3ph-w7gj-g6xm
  "markdown-it": "15.0.1", // GHSA-253c-mchw-3w2r
  "smol-toml": "1.9.0", // GHSA-r4xh-jqrq-34v2
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
