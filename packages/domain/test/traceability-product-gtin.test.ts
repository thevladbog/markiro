import { describe, expect, it } from "vitest";
import { DomainError } from "../src/errors.js";
import * as domainPackage from "../src/index.js";
import { normalizeCatalogGtin } from "../src/traceability/products/gtin.js";

const profiles = ["RU_CHZ", "US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const;

function captureDomainError(profile: unknown, input: unknown): DomainError {
  try {
    normalizeCatalogGtin(profile, input);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    if (error instanceof DomainError) return error;
  }
  throw new Error("Expected normalizeCatalogGtin to throw DomainError");
}

describe("catalog GTIN policy", () => {
  it.each(profiles)("normalizes every supported GS1 length for %s", (profile) => {
    expect(normalizeCatalogGtin(profile, "96385074")).toBe("00000096385074");
    expect(normalizeCatalogGtin(profile, "036000291452")).toBe("00036000291452");
    expect(normalizeCatalogGtin(profile, "4006381333931")).toBe("04006381333931");
    expect(normalizeCatalogGtin(profile, "10012345678902")).toBe("10012345678902");
  });

  it.each(["US_FSMA204_PROCESSOR", "US_GENERIC_LOT_TRACEABILITY"] as const)(
    "allows an absent GTIN for %s",
    (profile) => {
      expect(normalizeCatalogGtin(profile, null)).toBeNull();
      expect(normalizeCatalogGtin(profile, undefined)).toBeNull();
    },
  );

  it("requires a GTIN for the RU profile", () => {
    expect(captureDomainError("RU_CHZ", null).code).toBe("GTIN_REQUIRED");
    expect(captureDomainError("RU_CHZ", undefined).code).toBe("GTIN_REQUIRED");
  });

  it.each([
    "",
    "   ",
    " 96385074",
    "96385074 ",
    "96385075",
    "1234567",
    "123456789012345",
    "96385O74",
    96385074,
    true,
    ["96385074"],
    { gtin: "96385074" },
  ])("rejects malformed or coerced GTIN value %j for every profile", (input) => {
    for (const profile of profiles) {
      expect(captureDomainError(profile, input).code).toBe("GTIN_INVALID");
    }
  });

  it.each([
    [undefined, "96385074"],
    [undefined, undefined],
    [null, null],
    ["", "96385074"],
    ["   ", null],
    ["us_fsma204_processor", "96385074"],
    ["US_fsma204_PROCESSOR", undefined],
    ["UNKNOWN", "96385074"],
  ])("rejects unknown profile %j before interpreting GTIN %j", (profile, input) => {
    expect(captureDomainError(profile, input).code).toBe("invalid_traceability_profile");
  });

  it("does not echo rejected profile or GTIN values in failure messages", () => {
    const invalidGtin = "DO_NOT_ECHO_GTIN_987";
    const invalidProfile = "DO_NOT_ECHO_PROFILE_654";
    expect(captureDomainError("US_FSMA204_PROCESSOR", invalidGtin).message).not.toContain(
      invalidGtin,
    );
    expect(captureDomainError(invalidProfile, "96385074").message).not.toContain(invalidProfile);
  });

  it("exposes the catalog GTIN policy from the public package entry", () => {
    expect(domainPackage.normalizeCatalogGtin).toBe(normalizeCatalogGtin);
  });
});
