import { describe, expect, it } from "vitest";

import { AUTONOM_PAGES, AUTONOM_SEARCH_PAGES } from "./autonom-pages";
import { HOME_FAQ, PRICING_FAQ } from "./autonom";
import { findTariff, TARIFFS } from "./pricing";

describe("standalone page registry", () => {
  it("keeps the same metadata limits as the topic pages", () => {
    for (const page of AUTONOM_PAGES) {
      expect(page.title.length).toBeLessThanOrEqual(70);
      expect(page.description.length).toBeGreaterThanOrEqual(100);
      expect(page.description.length).toBeLessThanOrEqual(180);
    }
    expect(AUTONOM_SEARCH_PAGES.map((page) => page.path)).toEqual(["/skachat/", "/stoimost/"]);
  });

  it("publishes the prices of spec 3.2 and nothing else", () => {
    expect(TARIFFS.map((tariff) => [tariff.code, tariff.pricePerYear])).toEqual([
      ["start", 60_000],
      ["line", 120_000],
      ["workshop", 240_000],
      ["plant", null],
    ]);
    expect(findTariff("plant").priceFrom).toBe(400_000);
    const pricing = AUTONOM_PAGES.find((page) => page.path === "/stoimost/");
    for (const tariff of TARIFFS) expect(pricing?.description).toContain(`«${tariff.name}»`);
  });

  it("keeps questions unique so FAQPage entries do not collide", () => {
    for (const faq of [HOME_FAQ, PRICING_FAQ]) {
      expect(new Set(faq.map((entry) => entry.question)).size).toBe(faq.length);
    }
  });
});
