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

  it("проверяет флаг inbound у входящего канала (commerceml)", () => {
    expect(describeChannel("commerceml").inbound).toBe(true);
  });

  it("проверяет флаг inbound у невходящего канала (public_api)", () => {
    expect(describeChannel("public_api").inbound).toBe(false);
  });

  it("схема другого канала принимает произвольные поля", () => {
    const publicApiSchema = describeChannel("public_api").settingsSchema;
    const arbitrary = publicApiSchema.safeParse({
      unknownField: "anything",
      anotherField: 42,
      nested: { data: true },
    });
    expect(arbitrary.success).toBe(true);
  });

  it("commerceml схема требует minLength для priceType", () => {
    const emptyPrice = describeChannel("commerceml").settingsSchema.safeParse({
      priceType: "",
    });
    expect(emptyPrice.success).toBe(false);
  });

  it("commerceml схема делает priceType опциональным", () => {
    const noPriceType = describeChannel("commerceml").settingsSchema.safeParse({});
    expect(noPriceType.success).toBe(true);
  });

  it("commerceml схема применяет default(false) для splitWriteoffDocument", () => {
    const noSplitDefault = describeChannel("commerceml").settingsSchema.safeParse({});
    expect(noSplitDefault.success).toBe(true);
    if (noSplitDefault.success) {
      expect(noSplitDefault.data.splitWriteoffDocument).toBe(false);
    }
  });

  it("public_api канал доступен", () => {
    expect(describeChannel("public_api").available).toBe(true);
  });

  // Fix 1 (review, task 15 follow-up): `usesExchangeCredentials` is
  // narrower than both `available` and `inbound` -- `public_api` is
  // available and `commerceml` is inbound, but only `commerceml` actually
  // authenticates with the login+secret pair `IntegrationsService.issueCredentials`
  // mints (see that method's guard on this flag).
  it("только commerceml пользуется учётными данными обмена", () => {
    expect(describeChannel("commerceml").usesExchangeCredentials).toBe(true);
    expect(describeChannel("public_api").usesExchangeCredentials).toBe(false);
    expect(describeChannel("gis_mt_files").usesExchangeCredentials).toBe(false);
    expect(describeChannel("chestny_znak").usesExchangeCredentials).toBe(false);
  });
});
