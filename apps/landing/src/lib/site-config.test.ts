import { describe, expect, it } from "vitest";

import { readPublicSiteConfig } from "./site-config";

describe("readPublicSiteConfig", () => {
  it("keeps optional contact channels absent instead of inventing placeholders", () => {
    expect(readPublicSiteConfig({})).toEqual({
      demoEndpoint: null,
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

  it("accepts only a credential-free HTTPS lead endpoint", () => {
    expect(
      readPublicSiteConfig({
        PUBLIC_DEMO_ENDPOINT: "https://admin.markiro.app/public/demo-requests",
      }).demoEndpoint,
    ).toBe("https://admin.markiro.app/public/demo-requests");

    expect(() =>
      readPublicSiteConfig({ PUBLIC_DEMO_ENDPOINT: "http://markiro.app/leads" }),
    ).toThrow("PUBLIC_DEMO_ENDPOINT must use HTTPS");

    expect(() =>
      readPublicSiteConfig({ PUBLIC_DEMO_ENDPOINT: "https://token@markiro.app/leads" }),
    ).toThrow("PUBLIC_DEMO_ENDPOINT must not contain credentials");
  });

  it("treats whitespace-only values as absent", () => {
    expect(readPublicSiteConfig({ PUBLIC_DEMO_ENDPOINT: "  ", PUBLIC_PHONE: "  " })).toEqual({
      demoEndpoint: null,
      phone: null,
    });
  });
});
