import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { formatFingerprint } from "../src/app/fingerprint.js";

// Bound before the URL is built (see test/protocol.test.ts).
const testModuleUrl = import.meta.url;

describe("formatFingerprint", () => {
  it("shows the first 32 hex characters in eight upper-case groups of four", () => {
    expect(formatFingerprint("0123456789abcdef".repeat(4))).toBe(
      "0123 4567 89AB CDEF 0123 4567 89AB CDEF",
    );
  });

  it("shows the cases of the shared fixture, whose fingerprints are the SHA-256 of their DER", () => {
    const { cases } = JSON.parse(
      readFileSync(new URL("../proto/fixtures/fingerprint.json", testModuleUrl), "utf8"),
    ) as { cases: { derHex: string; fingerprint: string; display: string }[] };
    expect(cases.length).toBeGreaterThanOrEqual(4);
    for (const { derHex, fingerprint, display } of cases) {
      expect(createHash("sha256").update(Buffer.from(derHex, "hex")).digest("hex")).toBe(
        fingerprint,
      );
      expect(formatFingerprint(fingerprint)).toBe(display);
    }
  });
});
