import assert from "node:assert/strict";
import test from "node:test";
import { isTlcSourceReferenceUrl } from "../../../packages/domain/src/traceability/lots/source.ts";

// Run without a bundler on the actual Node runtime used by the isolated job.
// Node 24.20.0 accepts empty ACE labels whereas 24.18.0 rejects them;
// application validation must not depend on that runtime difference.
test("TLC source references reject empty ACE host labels on the actual Node runtime", () => {
  for (const value of [
    "https://xn--/",
    "https://XN--.example.test/",
    "https://source.xn--/",
    "https://%78n--/",
  ]) {
    assert.equal(isTlcSourceReferenceUrl(value), false, value);
  }
  for (const value of [
    "https://例え.テスト/Ä",
    "https://xn--r8jz45g.xn--zckzah/Ä",
    "https://example.test/xn--?source=xn--",
  ]) {
    assert.equal(isTlcSourceReferenceUrl(value), true, value);
  }
});
