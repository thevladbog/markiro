import { describe, expect, it } from "vitest";

import * as domain from "../src/index.js";

describe("deployment edition and profile policy", () => {
  it.each(["RU", "US"])("accepts the explicit %s edition", (edition) => {
    expect(domain.parseDeploymentEdition(edition)).toBe(edition);
  });

  it.each([undefined, null, "", "ru", "us", " US ", "EU", {}, 1])(
    "rejects an absent or invalid edition without a default: %j",
    (edition) => {
      expect(() => domain.parseDeploymentEdition(edition)).toThrowError(
        expect.objectContaining({ code: "invalid_deployment_edition" }),
      );
    },
  );

  it.each([
    ["US", "US_FSMA204_PROCESSOR"],
    ["US", "US_GENERIC_LOT_TRACEABILITY"],
    ["RU", "RU_CHZ"],
  ] as const)("allows %s / %s", (edition, profile) => {
    expect(() => domain.assertProfileAllowed(edition, profile)).not.toThrow();
  });

  it.each([
    ["US", "RU_CHZ"],
    ["RU", "US_FSMA204_PROCESSOR"],
    ["RU", "US_GENERIC_LOT_TRACEABILITY"],
  ] as const)("rejects the cross-edition profile %s / %s", (edition, profile) => {
    expect(() => domain.assertProfileAllowed(edition, profile)).toThrowError(
      expect.objectContaining({ code: "profile_not_allowed_in_edition" }),
    );
  });

  it.each([undefined, null, {}, "", "us_fsma204_processor", "toString", "__proto__"])(
    "rejects unknown profile input: %j",
    (profile) => {
      expect(() => domain.assertProfileAllowed("US", profile)).toThrowError(
        expect.objectContaining({ code: "invalid_traceability_profile" }),
      );
    },
  );

  it("does not let a caller widen another consumer's edition allow-list", () => {
    const profiles = domain.allowedProfiles("US");
    expect(Reflect.set(profiles, "0", "RU_CHZ")).toBe(false);
    expect(domain.allowedProfiles("US")).toEqual([
      "US_FSMA204_PROCESSOR",
      "US_GENERIC_LOT_TRACEABILITY",
    ]);
    expect(() => domain.assertProfileAllowed("US", "RU_CHZ")).toThrowError(
      expect.objectContaining({ code: "profile_not_allowed_in_edition" }),
    );
  });

  it.each([
    ["RU_CHZ", false, false, true, []],
    [
      "US_GENERIC_LOT_TRACEABILITY",
      true,
      false,
      false,
      ["receiving", "transformation", "shipping"],
    ],
    ["US_FSMA204_PROCESSOR", true, true, false, ["receiving", "transformation", "shipping"]],
  ] as const)(
    "derives features for %s",
    (profile, traceability, ftrClaims, ruRegulatory, cteSet) => {
      expect(domain.profileFeatures(profile)).toEqual({
        traceability,
        ftrClaims,
        ruRegulatory,
        cteSet,
      });
    },
  );

  it("keeps generic claims disabled even after another consumer attempts mutation", () => {
    const features = domain.profileFeatures("US_GENERIC_LOT_TRACEABILITY");
    expect(Reflect.set(features, "ftrClaims", true)).toBe(false);
    expect(Reflect.set(features.cteSet, "3", "harvesting")).toBe(false);
    expect(domain.profileFeatures("US_GENERIC_LOT_TRACEABILITY").ftrClaims).toBe(false);
    expect(domain.profileFeatures("US_GENERIC_LOT_TRACEABILITY").cteSet).toHaveLength(3);
  });
});

describe("edition-aware interface locales", () => {
  it.each([
    ["US", undefined, "en-US"],
    ["US", null, "en-US"],
    ["US", "es", "es-US"],
    ["US", "es-US", "es-US"],
    ["US", "es-MX", "es-US"],
    ["US", "ES-es", "es-US"],
    ["US", "en-GB", "en-US"],
    ["US", "ru-RU", "en-US"],
    ["US", "fr-FR", "en-US"],
    ["US", "es_US", "en-US"],
    ["US", {}, "en-US"],
    ["US", 42, "en-US"],
    ["US", "", "en-US"],
    ["RU", undefined, "ru-RU"],
    ["RU", "ru", "ru-RU"],
    ["RU", "en-GB", "en-US"],
    ["RU", "es-US", "ru-RU"],
  ] as const)("resolves %s / %j to %s", (edition, preference, expected) => {
    expect(domain.resolveInterfaceLocale(edition, preference)).toBe(expected);
  });

  it("keeps Russian outside the U.S. locale menu and fallback", () => {
    const locales = domain.allowedInterfaceLocales("US");
    expect(locales).toEqual(["en-US", "es-US"]);
    expect(Reflect.set(locales, "0", "ru-RU")).toBe(false);
    expect(domain.resolveInterfaceLocale("US", "ru-RU")).toBe("en-US");
    expect(domain.allowedInterfaceLocales("RU")).toEqual(["ru-RU", "en-US"]);
  });
});
