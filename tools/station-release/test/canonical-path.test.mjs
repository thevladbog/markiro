import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isCanonicalAbsolutePath } from "../canonical-path.mjs";

test("accepts canonical Windows paths with native, forward, or mixed separators", () => {
  assert.equal(isCanonicalAbsolutePath("D:\\a\\_temp\\release.json", win32), true);
  assert.equal(isCanonicalAbsolutePath("D:/a/_temp/release.json", win32), true);
  assert.equal(isCanonicalAbsolutePath("D:\\a\\_temp/release.json", win32), true);
});

test("rejects non-canonical Windows paths", () => {
  assert.equal(isCanonicalAbsolutePath("a\\_temp\\release.json", win32), false);
  assert.equal(isCanonicalAbsolutePath("D:\\a\\..\\release.json", win32), false);
  assert.equal(isCanonicalAbsolutePath("D:\\a\\\\release.json", win32), false);
});

test("preserves strict canonical checks on POSIX", () => {
  assert.equal(isCanonicalAbsolutePath("/tmp/release.json", posix), true);
  assert.equal(isCanonicalAbsolutePath("tmp/release.json", posix), false);
  assert.equal(isCanonicalAbsolutePath("/tmp/../release.json", posix), false);
  assert.equal(isCanonicalAbsolutePath("/tmp//release.json", posix), false);
});

test("rejects non-string path values", () => {
  assert.equal(isCanonicalAbsolutePath(undefined, win32), false);
  assert.equal(isCanonicalAbsolutePath(null, posix), false);
});
