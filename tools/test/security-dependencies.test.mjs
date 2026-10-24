import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "js-yaml";

const lock = load(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"));

// Patched floors from the September and October 2026 GitHub Security triages.
// Check every resolved copy: a direct upgrade alone can leave an unsafe
// transitive copy.
const patched = {
  // 7.3.2 also covers GHSA-98hj-9722-w3j8
  astro: "7.3.3", // GHSA-26w7-cxv4-gfx2, GHSA-376h-93r7-7g6f, GHSA-mpr7-6m5w-76rw
  sharp: "0.35.5", // GHSA-rgj7-g3m4-5g8c, GHSA-wq5f-xc86-pv6w
  // 16.3.6: GHSA-2xp9-vwfh-vxw4, p293-qw3h-jr36, vcvr-r3jv-pc5j; 16.3.8: cjq9-62q9-8jv4,
  // mcj8-r9mp-w47p, f87g-xv8r-7p7x, 39w2-rjm5-chcv, 4jqv-mc3x-m676, 3w37-wq28-93x7, h694-7cp9-m8p3
  next: "16.4.1", // GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r
  // 10.0.9 also covers GHSA-prgh-xp8r-p3m5, v53p-9fqp-m79j, 8vvx-rff5-p5rq, 6vj9-mwq6-2f5v
  nodemailer: "10.0.10", // GHSA-8m3c-c648-2xjj, GHSA-g57g-f23g-4646, GHSA-39m8-27wv-hr27
  // 2.4.0 also covers GHSA-wc9g-mqfw-jrwm, qvfw-j98x-7q72, 535w-7cp7-47q4, qfvm-cv95-jqjf
  multer: "2.4.0", // GHSA-3pph-fpjx-jg34
  qs: "6.16.0", // GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g
  svgo: "4.1.0", // GHSA-4vpr-x523-8j87, GHSA-w27v-7q3p-w38r
  "proxy-addr": "2.0.8", // GHSA-jqcg-44mw-7w3h
  "@vue/server-renderer": "3.5.42", // GHSA-g2v6-rqmx-r4w6
  // 5.9.3 also covers GHSA-mcm9-63f2-9j32, wf3x-273g-mvxv, x5rw-q4pp-hg5g, 4q55-j62x-fr9h, 9rgm-9g3h-6x36
  devalue: "5.9.3", // GHSA-j22f-vq7h-c4qm, GHSA-hx4r-w6wj-j8fg
  "fast-uri": "3.1.8", // GHSA-58mr-gqgx-xq4g, GHSA-qw65-cvwx-89v3, GHSA-hrr3-gc8f-f4qj
  // 10.7.1 also covers GHSA-j6r3-76f7-8jcv, h3mg-xc3c-68pw, rpw4-54j3-4h4q, 2vr4-cq9g-pvrc
  "ip-address": "10.7.4", // GHSA-rxp7-6hxx-x8q5
  "brace-expansion": "5.0.12", // GHSA-q2hr-2g5m-vwhr
  "engine.io": "6.6.10", // GHSA-2gc4-cqfq-p2gv
  // 7.29.1 also covers GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3 and seven lower advisories
  undici: "7.30.1", // GHSA-xjj6-f33q-929c, GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472
  "js-yaml": "5.4.1", // GHSA-r3ph-w7gj-g6xm
  // 15.0.1 also covers GHSA-253c-mchw-3w2r, 15.0.2 GHSA-r7fv-28h4-cvq7
  "markdown-it": "15.0.3", // GHSA-vfgh-jcmw-g37q, GHSA-gfr2-rv44-r23c
  "smol-toml": "1.9.0", // GHSA-r4xh-jqrq-34v2
  // 2.18.0 also covers GHSA-x3q4-9hxx-gx8m, GHSA-cv27-6wvh-8x7j
  "sanitize-html": "2.18.0", // GHSA-374f-7chj-9948
  // 8.2.4 also covers GHSA-587h-7wmj-h5pm, r825-w8mm-5pxw (bundled launch-editor), rq7h-c2jc-7f22, 9jrq-w75r-8gcw
  vite: "8.2.4", // GHSA-698v-4r3x-3vcv, GHSA-vfpm-58rq-9qcg
  "@vitest/mocker": "4.1.12", // GHSA-xp26-3454-mjgp, GHSA-qxg6-89mg-rqv8
  "source-map-js": "1.2.2", // GHSA-68fv-2mgg-jv7q
  // No release is named as patched; 4.3.0 is the first outside the <=4.2.0 range.
  "http-cache-semantics": "4.3.0", // GHSA-ch52-4w7c-c8xp
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
