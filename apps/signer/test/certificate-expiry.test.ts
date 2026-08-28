import { describe, expect, it } from "vitest";
import { expiryWarning } from "../src/components/CertificatePicker.js";

describe("expiryWarning", () => {
  const now = new Date("2026-08-28T00:00:00.000Z");

  it("warns once a certificate is inside the two week window", () => {
    expect(expiryWarning("2026-09-05T00:00:00.000Z", now)).toBe("expiring");
  });

  it("says nothing while the certificate has plenty of life", () => {
    expect(expiryWarning("2027-03-01T00:00:00.000Z", now)).toBe(null);
  });

  it("reports an already expired certificate distinctly", () => {
    expect(expiryWarning("2026-08-01T00:00:00.000Z", now)).toBe("expired");
  });
});
