import { describe, expect, it } from "vitest";
import { findSeoPage } from "../content/pages";
import { buildPageGraph } from "./seo";

describe("English V4 home", () => {
  it("matches the manual-packing message and separates office, station and handheld roles", () => {
    const page = findSeoPage("/en/");
    expect(page.heading).toBe("Aggregation software for manually packed products");
    const nodes = buildPageGraph(page)["@graph"];
    expect(nodes.find((n) => n["@type"] === "WebPage")).toMatchObject({
      name: page.heading,
      inLanguage: "en",
      mainEntity: { "@id": "https://markiro.app/#software" },
    });
    const software = nodes.find((n) => n["@id"] === "https://markiro.app/#software");
    expect(software).toMatchObject({
      operatingSystem: ["Windows 10", "Windows 11"],
      inLanguage: "ru",
    });
    expect(software?.featureList).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Office on PC:"),
        expect.stringContaining("Station:"),
      ]),
    );
    const handheld = nodes.find((n) => n["@id"] === "https://markiro.app/#handheld-software");
    expect(handheld?.description).toContain("same operations as the station");
    expect(handheld).toMatchObject({
      operatingSystem: "Android 9+",
      softwareRequirements: { "@id": "https://markiro.app/#software" },
    });
    expect(nodes.find((n) => n["@type"] === "FAQPage")?.mainEntity).toEqual(
      page.faq?.map((f) => ({
        "@type": "Question",
        name: f.question,
        acceptedAnswer: { "@type": "Answer", text: f.answer },
      })),
    );
  });
});
