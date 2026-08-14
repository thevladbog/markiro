import { describe, expect, it } from "vitest";

import { validateDemoLead } from "./demo-form";

describe("validateDemoLead", () => {
  it("trims text fields and normalizes a Russian phone", () => {
    expect(
      validateDemoLead({
        company: "  Завод Север  ",
        name: "  Анна  ",
        phone: "8 (999) 123-45-67",
      }),
    ).toEqual({
      ok: true,
      value: {
        company: "Завод Север",
        name: "Анна",
        phone: "+79991234567",
      },
    });
  });

  it("returns one field error for every missing value", () => {
    expect(validateDemoLead({ company: " ", name: "", phone: "" })).toEqual({
      errors: {
        company: "Укажите компанию",
        name: "Укажите имя",
        phone: "Укажите телефон",
      },
      ok: false,
    });
  });

  it("returns English validation errors for the English form", () => {
    expect(validateDemoLead({ company: " ", name: "", phone: "" }, "en")).toEqual({
      errors: {
        company: "Enter your company",
        name: "Enter your name",
        phone: "Enter a phone number",
      },
      ok: false,
    });
  });

  it.each(["+7 999 12", "+1 202 555 0114", "+7 999 123-45-67 доб. 10"])(
    "rejects an invalid phone without echoing it: %s",
    (phone) => {
      expect(validateDemoLead({ company: "Завод", name: "Анна", phone })).toEqual({
        errors: { phone: "Проверьте российский номер телефона" },
        ok: false,
      });
    },
  );

  it("bounds public lead fields", () => {
    expect(
      validateDemoLead({
        company: "К".repeat(121),
        name: "А".repeat(81),
        phone: "+7 999 123-45-67",
      }),
    ).toEqual({
      errors: {
        company: "Название компании должно быть короче 121 символа",
        name: "Имя должно быть короче 81 символа",
      },
      ok: false,
    });
  });
});
