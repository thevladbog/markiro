import { describe, expect, it } from "vitest";

import { readPublicSiteConfig } from "./site-config";

const ENABLED_ENV = {
  PUBLIC_DEMO_CONSENT_VERSION: "2026-08-14",
  PUBLIC_DEMO_SUBMISSION_ENABLED: "true",
  PUBLIC_PERSONAL_DATA_CONSENT_PATH: "/personal-data-consent/",
  PUBLIC_PRIVACY_POLICY_PATH: "/privacy/",
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
      consentVersion: "2026-08-14",
      demoEndpoint: "/api/demo-requests",
      legalLinks: {
        consent: "/personal-data-consent/",
        privacy: "/privacy/",
      },
      phone: null,
    });
  });

  it.each([
    "PUBLIC_DEMO_CONSENT_VERSION",
    "PUBLIC_PERSONAL_DATA_CONSENT_PATH",
    "PUBLIC_PRIVACY_POLICY_PATH",
    "PUBLIC_SMARTCAPTCHA_CLIENT_KEY",
  ] as const)("rejects enabled mode without %s", (missing) => {
    const env: Record<string, string | undefined> = { ...ENABLED_ENV };
    delete env[missing];
    expect(() => readPublicSiteConfig(env)).toThrow("demo submission requires");
  });

  it.each(["captcha-key", "ysc2_wrong-prefix", " ysc1_ "])(
    "rejects an invalid SmartCaptcha public key: %s",
    (key) => {
      expect(() =>
        readPublicSiteConfig({ ...ENABLED_ENV, PUBLIC_SMARTCAPTCHA_CLIENT_KEY: key }),
      ).toThrow("PUBLIC_SMARTCAPTCHA_CLIENT_KEY must begin with ysc1_");
    },
  );

  it("rejects unsafe legal paths in enabled mode", () => {
    expect(() =>
      readPublicSiteConfig({
        ...ENABLED_ENV,
        PUBLIC_PRIVACY_POLICY_PATH: "https://other.example/privacy",
      }),
    ).toThrow("PUBLIC_PRIVACY_POLICY_PATH must be a same-origin absolute path");
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
