import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeJournal } from "../log-sanitizer.mjs";

test("journal sanitizer allowlists units, redacts credential shapes, and enforces byte and line bounds", () => {
  const output = sanitizeJournal(
    [
      { unit: "markiro-readiness-observer.service", message: "smtp_degraded" },
      { unit: "markiro-deploy.service", message: "token=secret-value deployment failed" },
      { unit: "untrusted.service", message: "must not ship" },
      { unit: "docker.service", message: "x".repeat(2000) },
    ],
    { maxBytes: 1024, maxLineBytes: 256 },
  );
  assert.match(output, /smtp_degraded/);
  assert.match(output, /token=\[REDACTED\]/);
  assert.doesNotMatch(output, /secret-value|must not ship/);
  assert.ok(Buffer.byteLength(output) <= 1024);
  assert.ok(output.split("\n").every((line) => Buffer.byteLength(line) <= 256));
});
