import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import DeviceMockup from "./DeviceMockup.astro";

function isAstroComponent(
  value: unknown,
): value is Parameters<AstroContainer["renderToString"]>[0] {
  return (
    typeof value === "function" &&
    "isAstroComponentFactory" in value &&
    value.isAstroComponentFactory === true
  );
}

describe("presentational equipment mockups", () => {
  it.each(["monitor", "handheld", "none"] as const)(
    "keeps the original screenshot accessible in the %s frame",
    async (kind) => {
      const container = await AstroContainer.create();
      const component: unknown = DeviceMockup;
      if (!isAstroComponent(component)) throw new Error("Expected a compiled Astro component");
      const html = await container.renderToString(component, {
        props: { kind },
        slots: {
          default: '<img src="/screen.png" alt="Маркиро: рабочий экран" width="1440" height="900">',
        },
      });
      const document = new JSDOM(html).window.document;
      const screenshot = document.querySelector("img");
      expect(screenshot?.getAttribute("src")).toBe("/screen.png");
      expect(screenshot?.getAttribute("alt")).toBe("Маркиро: рабочий экран");
      expect(screenshot?.getAttribute("width")).toBe("1440");
      expect(screenshot?.getAttribute("height")).toBe("900");
      expect(screenshot?.closest('[aria-hidden="true"]')).toBeNull();
      expect(document.querySelector("button, a, input")).toBeNull();
    },
  );
});
