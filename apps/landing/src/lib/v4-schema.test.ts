import { describe, expect, it } from "vitest";
import { findSeoPage } from "../content/pages";
import { findAutonomPage } from "../content/autonom-pages";
import { buildPageGraph, buildAutonomPageGraph } from "./seo";

describe("V4 public product graph", () => {
  const graphs = () => [
    buildPageGraph(findSeoPage("/")),
    buildAutonomPageGraph(findAutonomPage("/skachat/")),
    buildAutonomPageGraph(findAutonomPage("/stoimost/"), { offers: true }),
  ];
  it("resolves each main entity and separates the Windows roles from the Android station-equivalent app", () => {
    for (const graph of graphs()) {
      const page = graph["@graph"].find((n) => n["@type"] === "WebPage");
      const software = graph["@graph"].find((n) => n["@id"] === "https://markiro.app/#software");
      const handheld = graph["@graph"].find(
        (n) => n["@id"] === "https://markiro.app/#handheld-software",
      );
      expect(software).toMatchObject({
        operatingSystem: ["Windows 10", "Windows 11"],
        processorRequirements: "x64",
      });
      expect(software?.featureList).toEqual(
        expect.arrayContaining([
          expect.stringContaining("Офис на ПК"),
          expect.stringContaining("Станция:"),
        ]),
      );
      expect(handheld).toMatchObject({
        operatingSystem: "Android 9+",
        description: "Проверка кодов, сборка коробов и паллет, печать этикеток — как на станции.",
        softwareRequirements: { "@id": "https://markiro.app/#software" },
      });
      const target = (page?.mainEntity as { "@id": string } | undefined)?.["@id"];
      expect(graph["@graph"].some((n) => n["@id"] === target)).toBe(true);
      for (const n of graph["@graph"])
        for (const key of ["review", "aggregateRating", "downloadUrl", "softwareVersion"])
          expect(n).not.toHaveProperty(key);
    }
  });
  it("publishes three annual offers with no request-only or trial price", () => {
    const product = graphs()[2]?.["@graph"].find((n) => n["@type"] === "Product");
    expect(product?.offers).toEqual([
      expect.objectContaining({
        price: 60000,
        priceCurrency: "RUB",
        url: "https://markiro.app/stoimost/#plan-start",
      }),
      expect.objectContaining({
        price: 120000,
      }),
      expect.objectContaining({ price: 240000 }),
    ]);
    const offers = product?.offers as readonly {
      description: string;
      priceSpecification: unknown;
    }[];
    expect(offers[1]?.description).toContain("станция и ТСД");
    expect(offers[1]?.priceSpecification).toMatchObject({
      billingDuration: "P1Y",
      valueAddedTaxIncluded: false,
    });
  });
  it("uses the final manual-packing headline", () => {
    expect(findSeoPage("/").heading).toBe("Программа для агрегации кодов маркировки");
  });
});
