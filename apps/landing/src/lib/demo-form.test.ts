import { describe, expect, it } from "vitest";

import { validateDemoLead } from "./demo-form";

describe("validateDemoLead", () => {
  it("trims text fields, normalizes email, and normalizes a Russian phone", () => {
    expect(
      validateDemoLead({
        company: "  Завод Север  ",
        email: " ANNA@EXAMPLE.TEST ",
        name: "  Анна  ",
        phone: "8 (999) 123-45-67",
      }),
    ).toEqual({
      ok: true,
      value: {
        company: "Завод Север",
        email: "anna@example.test",
        name: "Анна",
        phone: "+79991234567",
      },
    });
  });

  it("omits an empty optional phone", () => {
    expect(
      validateDemoLead(
        {
          name: "Ada",
          company: "Factory",
          email: " ADA@EXAMPLE.TEST ",
          phone: "",
        },
        "en",
      ),
    ).toEqual({
      ok: true,
      value: { name: "Ada", company: "Factory", email: "ada@example.test" },
    });
  });

  it("normalizes an English-page international phone", () => {
    expect(
      validateDemoLead(
        {
          company: "Factory",
          email: "ada@example.test",
          name: "Ada",
          phone: "+1 (202) 555-0114",
        },
        "en",
      ),
    ).toEqual({
      ok: true,
      value: {
        company: "Factory",
        email: "ada@example.test",
        name: "Ada",
        phone: "+12025550114",
      },
    });
  });

  it.each([".ada@example.test", "ada..lovelace@example.test", "ada@example.c"])(
    "rejects email syntax rejected by the Task 4 Zod contract: %s",
    (email) => {
      expect(validateDemoLead({ company: "Factory", email, name: "Ada", phone: "" }, "en")).toEqual(
        {
          errors: { email: "Enter a valid email address" },
          ok: false,
        },
      );
    },
  );

  it("matches the Task 4 email length boundary", () => {
    const acceptedEmail = `${"a".repeat(241)}@example.test`;
    const rejectedEmail = `${"a".repeat(242)}@example.test`;
    expect(acceptedEmail).toHaveLength(254);
    expect(rejectedEmail).toHaveLength(255);

    expect(
      validateDemoLead({ company: "Factory", email: acceptedEmail, name: "Ada", phone: "" }, "en"),
    ).toEqual({
      ok: true,
      value: { company: "Factory", email: acceptedEmail, name: "Ada" },
    });
    expect(
      validateDemoLead({ company: "Factory", email: rejectedEmail, name: "Ada", phone: "" }, "en"),
    ).toEqual({
      errors: { email: "Email must be shorter than 255 characters" },
      ok: false,
    });
  });

  it("returns one field error for every missing required value", () => {
    expect(validateDemoLead({ company: " ", email: "", name: "", phone: "" })).toEqual({
      errors: {
        company: "Укажите компанию",
        email: "Укажите email",
        name: "Укажите имя",
      },
      ok: false,
    });
  });

  it("returns English validation errors for the English form", () => {
    expect(
      validateDemoLead({ company: " ", email: "not-an-email", name: "", phone: "" }, "en"),
    ).toEqual({
      errors: {
        company: "Enter your company",
        email: "Enter a valid email address",
        name: "Enter your name",
      },
      ok: false,
    });
  });

  it.each(["+7 999 12", "+1 202 555 0114", "+7 999 123-45-67 доб. 10"])(
    "rejects an invalid Russian phone without echoing it: %s",
    (phone) => {
      expect(
        validateDemoLead({
          company: "Завод",
          email: "anna@example.test",
          name: "Анна",
          phone,
        }),
      ).toEqual({
        errors: { phone: "Проверьте российский номер телефона" },
        ok: false,
      });
    },
  );

  it.each(["202 555 0114", "+12 34", "+1234567890123456", "+1 202 CALL-NOW"])(
    "rejects an invalid English-page phone without echoing it: %s",
    (phone) => {
      expect(
        validateDemoLead(
          { company: "Factory", email: "ada@example.test", name: "Ada", phone },
          "en",
        ),
      ).toEqual({
        errors: { phone: "Enter a valid international phone number" },
        ok: false,
      });
    },
  );

  it("bounds public lead fields", () => {
    expect(
      validateDemoLead({
        company: "К".repeat(121),
        email: `${"a".repeat(242)}@example.test`,
        name: "А".repeat(81),
        phone: "+7 999 123-45-67",
      }),
    ).toEqual({
      errors: {
        company: "Название компании должно быть короче 121 символа",
        email: "Email должен быть короче 255 символов",
        name: "Имя должно быть короче 81 символа",
      },
      ok: false,
    });
  });
});
