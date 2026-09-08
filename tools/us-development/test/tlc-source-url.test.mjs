import assert from "node:assert/strict";
import test from "node:test";
import { isTraceabilityReferenceHost } from "../../../packages/domain/src/traceability/reference-host.ts";

// Run without a bundler on the actual Node runtime used by the isolated job.
// Node 24.20.0 accepts invalid ACE labels that 24.18.0 rejects. Both the coverage
// and TLC/evidence validators use this pinned host check after native URL parsing.
const validHost = (value) => {
  try {
    return isTraceabilityReferenceHost(new URL(value).hostname);
  } catch {
    return false;
  }
};
test("traceability reference hosts keep pinned IDNA rules on the actual Node runtime", () => {
  for (const value of [
    "https://xn--/",
    "https://XN--.example.test/",
    "https://source.xn--/",
    "https://%78n--/",
    "https://xn--a.example/source",
    "https://\u200d.test/source",
    "https://\u200c.test/source",
    "https://a\u200cb.test/source",
    "https://[invalid]/path",
    "https://999.999.999.999/path",
  ]) {
    assert.equal(validHost(value), false, value);
  }
  for (const value of [
    "https://例え.テスト/Ä",
    "https://xn--r8jz45g.xn--zckzah/Ä",
    "https://example.test/xn--?source=xn--",
    "https://☃.net/source",
    "https://क्‌ष.test/source",
    "https://xn--11b2ezcs70k.test/source",
    "https://[2001:db8::1]:443/path",
  ]) {
    assert.equal(validHost(value), true, value);
  }
});
