import { describe, expect, it } from "vitest";

import { formatFingerprint } from "../src/app/fingerprint.js";

describe("formatFingerprint", () => {
  it("shows the first 32 hex characters in eight upper-case groups of four", () => {
    expect(formatFingerprint("0123456789abcdef".repeat(4))).toBe(
      "0123 4567 89AB CDEF 0123 4567 89AB CDEF",
    );
  });
});
