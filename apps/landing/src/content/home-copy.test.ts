import { describe, expect, it } from "vitest";

import { getUiCopy } from "./ui";

const ru = getUiCopy("ru").home;
const en = getUiCopy("en").home;
const NEW_KEYS = [
  "mapHero",
  "productSection",
  "offline",
  "traceability",
  "filmBlock",
  "rollout",
  "documents",
] as const;

function text(value: unknown): string {
  return JSON.stringify(value);
}

describe("home copy", () => {
  it("keeps Russian and English in the same shape", () => {
    expect(ru.mapHero.spots.map((spot) => [spot.id, spot.target])).toEqual(
      en.mapHero.spots.map((spot) => [spot.id, spot.target]),
    );
    expect(ru.productSection.rows.map((row) => [row.id, row.bullets.length])).toEqual(
      en.productSection.rows.map((row) => [row.id, row.bullets.length]),
    );
    expect(ru.productSection.cards.map((card) => card.id)).toEqual(
      en.productSection.cards.map((card) => card.id),
    );
    expect(ru.offline.points).toHaveLength(en.offline.points.length);
    expect(ru.rollout.steps).toHaveLength(en.rollout.steps.length);
    expect(ru.documents.covers.map((cover) => cover.code)).toEqual(
      en.documents.covers.map((cover) => cover.code),
    );
  });

  it("sends every hotspot to a product anchor", () => {
    expect(ru.mapHero.spots.map((spot) => [spot.id, spot.target])).toEqual([
      ["line", "#product-line"],
      ["packing", "#product-line"],
      ["warehouse", "#product-handheld"],
      ["kiosk", "#product-kiosk"],
      ["office", "#product-office"],
    ]);
  });

  it("numbers the section kickers in page order", () => {
    const kickers = (copy: typeof ru) =>
      [
        copy.productSection.kicker,
        copy.offline.kicker,
        copy.traceability.kicker,
        copy.filmBlock.kicker,
        copy.rollout.kicker,
        copy.documents.kicker,
      ].map((kicker) => kicker.slice(0, 2));
    expect(kickers(ru)).toEqual(["01", "02", "03", "04", "05", "06"]);
    expect(kickers(en)).toEqual(["01", "02", "03", "04", "05", "06"]);
  });

  it("states the product-group boundary honestly", () => {
    const ruText = text(NEW_KEYS.map((key) => ru[key]));
    const enText = text(NEW_KEYS.map((key) => en[key]));
    expect(ruText).toContain("любой маркируемой продукции");
    expect(ruText).toContain("Особенности вашей товарной группы сверяем до запуска");
    expect(enText).toContain("any marked goods");
    expect(enText).toContain("We check the rules of your product group before launch");
    expect(ruText).not.toMatch(/Сейчас — пиво/u);
    expect(enText).not.toMatch(/Currently focused on beer/u);
  });

  it("captions say what the frame shows", () => {
    const captions = (copy: typeof ru) =>
      text([
        copy.productSection.rows.map((row) => row.caption),
        copy.productSection.cards.map((card) => card.caption),
        copy.offline.caption,
        copy.traceability.caption,
      ]);
    expect(captions(ru)).not.toMatch(/НАСТОЯЩИЙ ЭКРАН|настоящий экран/u);
    expect(captions(en)).not.toMatch(/REAL SCREEN|real screen/iu);
  });
});
