import { describe, expect, it } from "vitest";

import { readPublicSiteConfig } from "./site-config";

describe("readPublicSiteConfig", () => {
  it("keeps optional contact channels absent instead of inventing placeholders", () => {
    expect(readPublicSiteConfig({})).toEqual({
      demoEndpoint: null,
      legalLinks: null,
      phone: null,
    });
  });

  it("normalizes a configured Russian phone for the tel link", () => {
    expect(readPublicSiteConfig({ PUBLIC_PHONE: "+7 999 123-45-67" }).phone).toEqual({
      display: "+7 999 123-45-67",
      href: "tel:+79991234567",
    });
    expect(readPublicSiteConfig({ PUBLIC_PHONE: "8 (999) 123-45-67" }).phone?.href).toBe(
      "tel:+79991234567",
    );
  });

  it.each(["123", "+1 202 555 0114", "+7 999 123-45-67 доб. 12"])(
    "rejects an unsafe public phone value: %s",
    (phone) => {
      expect(() => readPublicSiteConfig({ PUBLIC_PHONE: phone })).toThrow(
        "PUBLIC_PHONE must be a Russian phone number",
      );
    },
  );

  it("uses only the fixed same-origin lead route when legal links are configured", () => {
    expect(
      readPublicSiteConfig({
        PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/personal-data-consent/",
        PUBLIC_PRIVACY_POLICY_PATH: "/privacy/",
      }),
    ).toEqual({
      demoEndpoint: "/api/demo-requests",
      legalLinks: {
        consent: "/personal-data-consent/",
        privacy: "/privacy/",
      },
      phone: null,
    });

    expect(() =>
      readPublicSiteConfig({ PUBLIC_DEMO_SUBMISSION_ENABLED: "true" }),
    ).toThrow("demo submission requires privacy and personal-data consent paths");

    expect(() =>
      readPublicSiteConfig({
        PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/personal-data-consent/",
        PUBLIC_PRIVACY_POLICY_PATH: "https://other.example/privacy",
      }),
    ).toThrow("PUBLIC_PRIVACY_POLICY_PATH must be a same-origin absolute path");
  });

  it("does not accept a public cross-origin lead endpoint", () => {
    expect(
      readPublicSiteConfig({
        PUBLIC_DEMO_ENDPOINT: "https://admin.markiro.app/public/demo-requests",
      }),
    ).toEqual({ demoEndpoint: null, legalLinks: null, phone: null });
  });

  it("treats whitespace-only values as absent", () => {
    expect(readPublicSiteConfig({ PUBLIC_PHONE: "  " })).toEqual({
      demoEndpoint: null,
      legalLinks: null,
      phone: null,
    });
  });
});
