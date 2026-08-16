import { describe, expect, it } from "vitest";

import { readPublicSiteConfig } from "./site-config";

const ENABLED_ENV = {
  PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
  PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "ysc1_test-client-key",
} as const;

describe("readPublicSiteConfig", () => {
  it("keeps optional contact channels and the demo boundary absent", () => {
    expect(readPublicSiteConfig({})).toEqual({
      captchaClientKey: null,
      consentVersion: null,
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

  it("enables only the fixed same-origin route after the complete public config passes", () => {
    expect(readPublicSiteConfig(ENABLED_ENV)).toEqual({
      captchaClientKey: "ysc1_test-client-key",
      consentVersion: "MKR-PD-02/2026.08/01",
      demoEndpoint: "/api/demo-requests",
      legalLinks: {
        consent: "/personal-data-consent/",
        privacy: "/privacy/",
      },
      phone: null,
    });
  });

  it("uses the localized legal routes for an enabled English page", () => {
    expect(readPublicSiteConfig(ENABLED_ENV, "en").legalLinks).toEqual({
      consent: "/en/personal-data-consent/",
      privacy: "/en/privacy/",
    });
  });

  it("rejects enabled mode without the public captcha key", () => {
    expect(() => readPublicSiteConfig({ PUBLIC_DEMO_SUBMISSION_ENABLED: "true" })).toThrow(
      "demo submission requires",
    );
  });

  it.each(["captcha-key", "ysc2_wrong-prefix", " ysc1_ "])(
    "rejects an invalid SmartCaptcha public key: %s",
    (key) => {
      expect(() =>
        readPublicSiteConfig({ ...ENABLED_ENV, PUBLIC_SMARTCAPTCHA_CLIENT_KEY: key }),
      ).toThrow("PUBLIC_SMARTCAPTCHA_CLIENT_KEY must begin with ysc1_");
    },
  );

  it("does not allow environment values to override the released legal contract", () => {
    expect(
      readPublicSiteConfig({
        ...ENABLED_ENV,
        PUBLIC_DEMO_CONSENT_VERSION: "stray-version",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "https://other.example/consent",
        PUBLIC_PRIVACY_POLICY_PATH: "https://other.example/privacy",
      }),
    ).toMatchObject({
      consentVersion: "MKR-PD-02/2026.08/01",
      legalLinks: {
        consent: "/personal-data-consent/",
        privacy: "/privacy/",
      },
    });
  });

  it("ignores all stray demo values while disabled", () => {
    expect(
      readPublicSiteConfig({
        PUBLIC_DEMO_CONSENT_VERSION: "stray-version",
        PUBLIC_DEMO_ENDPOINT: "https://admin.markiro.app/public/demo-requests",
        PUBLIC_DEMO_SUBMISSION_ENABLED: "false",
        PUBLIC_PERSONAL_DATA_CONSENT_PATH: "https://other.example/consent",
        PUBLIC_PRIVACY_POLICY_PATH: "https://other.example/privacy",
        PUBLIC_SMARTCAPTCHA_CLIENT_KEY: "stray-key",
      }),
    ).toEqual({
      captchaClientKey: null,
      consentVersion: null,
      demoEndpoint: null,
      legalLinks: null,
      phone: null,
    });
  });

  it("treats whitespace-only values as absent", () => {
    expect(readPublicSiteConfig({ PUBLIC_PHONE: "  " })).toEqual({
      captchaClientKey: null,
      consentVersion: null,
      demoEndpoint: null,
      legalLinks: null,
      phone: null,
    });
  });
});
