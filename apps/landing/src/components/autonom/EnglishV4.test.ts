import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import PriceCards from "./PriceCards.astro";
import ScreenGallery from "./ScreenGallery.astro";
import V4Footer from "./V4Footer.astro";

function isAstroComponent(
  value: unknown,
): value is Parameters<AstroContainer["renderToString"]>[0] {
  return (
    typeof value === "function" &&
    "isAstroComponentFactory" in value &&
    value.isAstroComponentFactory === true
  );
}
async function render(component: unknown, props: Record<string, unknown>) {
  if (!isAstroComponent(component)) throw new Error("Expected a compiled Astro component");
  const container = await AstroContainer.create();
  return new JSDOM(await container.renderToString(component, { props })).window.document;
}

describe("English V4 shared components", () => {
  it("preserves plan codes and Russian download/invoice destinations with English copy", async () => {
    const doc = await render(PriceCards, { compact: true, locale: "en" });
    const plans = [...doc.querySelectorAll("article[data-tariff]")];
    expect(plans).toHaveLength(3);
    for (const plan of plans) {
      const code = plan.getAttribute("data-tariff");
      expect(plan.querySelector("[data-analytics]")?.getAttribute("href")).toBe(
        `/skachat/?tariff=${code}`,
      );
      expect(plan.querySelector("[data-analytics]")?.getAttribute("hreflang")).toBe("ru");
      expect(plan.querySelector(".ax-plan__invoice")?.getAttribute("href")).toBe(
        `/stoimost/?tarif=${code}#schet`,
      );
      expect(plan.textContent).toContain("Try for 14 days");
      expect(plan.textContent).toContain("Request an invoice");
    }
    expect(plans[1]?.textContent).toContain("station and a handheld");
    expect(doc.body.textContent).toContain("Office users are counted separately");
  });
  it("localizes the viewer and footer without changing Russian defaults", async () => {
    const gallery = await render(ScreenGallery, { locale: "en" });
    expect(gallery.querySelector("[data-screen-close]")?.textContent).toBe("Close");
    const footer = await render(V4Footer, { variant: "full", locale: "en" });
    expect(footer.querySelector('a[href="/en/instructions/"]')?.textContent).toBe("Instructions");
    expect(footer.querySelector('a[hreflang="ru"]')?.getAttribute("href")).toBe("/");
    expect(footer.querySelector("[data-consent-settings]")?.textContent).toBe("Cookie settings");
    const russian = await render(V4Footer, { variant: "full" });
    expect(russian.querySelector('a[href="/instruktsii/"]')?.textContent).toBe("Инструкции");
  });
});
