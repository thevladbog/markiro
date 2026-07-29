import { describe, expect, it } from "vitest";
import { CHANNELS, describeChannel } from "../src/modules/integrations/channel-registry";

describe("channel registry", () => {
  it("объявляет каналы, которые секция должна показать с первого дня", () => {
    expect(CHANNELS.map((c) => c.type)).toEqual([
      "commerceml",
      "public_api",
      "gis_mt_files",
      "chestny_znak",
    ]);
  });

  it("канал без адаптера объявлен недоступным, а не спрятан", () => {
    expect(describeChannel("chestny_znak").available).toBe(false);
    expect(describeChannel("gis_mt_files").available).toBe(false);
    expect(describeChannel("commerceml").available).toBe(true);
  });

  it("валидирует настройки схемой своего дескриптора", () => {
    const ok = describeChannel("commerceml").settingsSchema.safeParse({
      priceType: "Розничная",
      splitWriteoffDocument: false,
    });
    expect(ok.success).toBe(true);

    const bad = describeChannel("commerceml").settingsSchema.safeParse({ priceType: 42 });
    expect(bad.success).toBe(false);
  });

  it("не знает неизвестного типа", () => {
    expect(() => describeChannel("nope" as never)).toThrow(/unknown channel/i);
  });
});
