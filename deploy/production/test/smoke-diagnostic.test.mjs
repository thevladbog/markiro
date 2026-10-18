import assert from "node:assert/strict";
import test from "node:test";

import {
  SMOKE_DIAGNOSTIC_MAX_LENGTH,
  SMOKE_DIAGNOSTIC_WITHHELD,
  recordSmokeDiagnostic,
  sanitizeSmokeMessage,
  smokeDiagnosticOf,
  smokeFailureLine,
} from "../smoke-diagnostic.mjs";

test("passes constant smoke messages and nothing that could carry a secret", () => {
  for (const message of [
    "CSP is not the production policy on admin /docs",
    "/openapi.json did not return valid JSON",
    "Public endpoint https://app.markiro.example is unreachable after 30 attempts (ECONNRESET)",
  ])
    assert.equal(sanitizeSmokeMessage(message), message);
  for (const message of [
    "",
    "a".repeat(SMOKE_DIAGNOSTIC_MAX_LENGTH + 1),
    "two\nlines",
    "tab\there",
    "cyrillic привет",
    "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    "0123456789abcdef0123456789abcdef01234567",
    "Authorization: Bearer x",
    "token=abc",
    undefined,
    { message: "object" },
  ])
    assert.equal(sanitizeSmokeMessage(message), undefined, String(message));
});

test("records one bounded line per error object and only for recorded errors", () => {
  const recorded = recordSmokeDiagnostic(new Error("HSTS is missing"));
  assert.equal(smokeDiagnosticOf(recorded), "HSTS is missing");
  assert.equal(smokeFailureLine(recorded), "MARKIRO_SMOKE_FAILURE HSTS is missing\n");

  const unrecorded = new Error("HSTS is missing");
  assert.equal(smokeDiagnosticOf(unrecorded), undefined);
  assert.equal(smokeFailureLine(unrecorded), "");
  for (const value of [undefined, null, "string", 7]) {
    assert.equal(smokeDiagnosticOf(recordSmokeDiagnostic(value)), undefined);
    assert.equal(smokeFailureLine(value), "");
  }
});

test("withholds unsafe messages but keeps the error class and code", () => {
  const unsafe = new Error("Bearer secret-value-with-details");
  assert.equal(smokeDiagnosticOf(recordSmokeDiagnostic(unsafe)), SMOKE_DIAGNOSTIC_WITHHELD);

  const network = new TypeError("fetch failed", {
    cause: { code: "ECONNRESET", detail: "10.0.0.1" },
  });
  const line = smokeFailureLine(recordSmokeDiagnostic(network));
  assert.equal(line, "MARKIRO_SMOKE_FAILURE fetch failed name=TypeError code=ECONNRESET\n");
  assert.equal(line.includes("10.0.0.1"), false);

  const hostile = Object.assign(new Error("ok"), { name: "Bad Name\nINJECT", code: "x\ny" });
  assert.equal(smokeDiagnosticOf(recordSmokeDiagnostic(hostile)), "ok");
});
