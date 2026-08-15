import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ZodValidationPipe } from "../src/zod.pipe";
import {
  demoRequestSchema,
  type DemoRequestDto,
} from "../src/modules/demo-requests/demo-request.schema";
import { DEMO_SOURCE_PATHS } from "../src/modules/demo-requests/demo-request-routes";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requestId: REQUEST_ID,
    locale: "en",
    sourcePath: "/en/packing-workstation/",
    consentVersion: "2026-08-14",
    name: "Ada",
    company: "Factory",
    email: "ada@example.test",
    phone: "+1 202 555 0114",
    website: "",
    captchaToken: "captcha-token",
    ...overrides,
  };
}

function parse(input: unknown): DemoRequestDto {
  return new ZodValidationPipe(demoRequestSchema).transform(input) as DemoRequestDto;
}

function expectInvalid(input: unknown): void {
  expect(() => parse(input)).toThrow(BadRequestException);
}

describe("demoRequestSchema", () => {
  it("trims bounded text, lowercases email, and normalizes an international phone", () => {
    expect(
      parse(
        validInput({
          name: " Ada ",
          company: " Factory ",
          email: " ADA@EXAMPLE.TEST ",
          phone: "+1 (202) 555-0114",
        }),
      ),
    ).toEqual({
      requestId: REQUEST_ID,
      locale: "en",
      sourcePath: "/en/packing-workstation/",
      consentVersion: "2026-08-14",
      name: "Ada",
      company: "Factory",
      email: "ada@example.test",
      phone: "+12025550114",
      website: "",
      captchaToken: "captcha-token",
    });
  });

  it.each([
    ["8 (999) 123-45-67", "+79991234567"],
    ["+7 999 123 45 67", "+79991234567"],
  ])("normalizes the Russian phone %s", (phone, expected) => {
    expect(
      parse(validInput({ locale: "ru", sourcePath: "/rabochee-mesto-upakovki/", phone })).phone,
    ).toBe(expected);
  });

  it("omits an empty optional phone", () => {
    const parsed = parse(validInput({ phone: "   " }));

    expect(parsed).not.toHaveProperty("phone");
  });

  it("trims the phone before applying its 30-character input bound", () => {
    expect(parse(validInput({ phone: "  +1 (202) 555-0114  " })).phone).toBe("+12025550114");
  });

  it("enforces locale-specific phone formats after punctuation removal", () => {
    expectInvalid(
      validInput({
        locale: "ru",
        sourcePath: "/rabochee-mesto-upakovki/",
        phone: "+1 (202) 555-0114",
      }),
    );
    expectInvalid(validInput({ phone: "8 (999) 123-45-67" }));
    expectInvalid(validInput({ phone: "+1 23" }));
    expectInvalid(validInput({ phone: `+${"1".repeat(16)}` }));
    expectInvalid(validInput({ phone: `+1${" ".repeat(29)}2025550114` }));
  });

  it("accepts exactly the 16 canonical published source paths", () => {
    expect(DEMO_SOURCE_PATHS).toEqual([
      "/",
      "/markirovka-chestny-znak/",
      "/sscc-i-agregatsiya/",
      "/rabochee-mesto-upakovki/",
      "/kiosk-samovydachi/",
      "/integratsiya-1c/",
      "/oflayn-rabota/",
      "/faq/",
      "/en/",
      "/en/chestny-znak-serialization/",
      "/en/sscc-and-aggregation/",
      "/en/packing-workstation/",
      "/en/self-service-pickup-kiosk/",
      "/en/1c-integration/",
      "/en/offline-production/",
      "/en/faq/",
    ]);

    for (const sourcePath of DEMO_SOURCE_PATHS) {
      const locale = sourcePath.startsWith("/en/") ? "en" : "ru";
      expect(
        parse(validInput({ locale, sourcePath, phone: locale === "ru" ? "+79991234567" : "" }))
          .sourcePath,
      ).toBe(sourcePath);
    }
  });

  it.each([
    "/en/packing-workstation",
    "/en/packing-workstation/?campaign=x",
    "https://markiro.app/en/packing-workstation/",
    "/en/packing-workstation/extra",
  ])("rejects a non-canonical source path %s", (sourcePath) => {
    expectInvalid(validInput({ sourcePath }));
  });

  it("enforces UUID, locale, consent, captcha, and honeypot bounds", () => {
    expectInvalid(validInput({ requestId: "not-a-uuid" }));
    expectInvalid(validInput({ locale: "de" }));
    expectInvalid(validInput({ consentVersion: "   " }));
    expectInvalid(validInput({ consentVersion: "v".repeat(65) }));
    expectInvalid(validInput({ captchaToken: "" }));
    expectInvalid(validInput({ captchaToken: "t".repeat(4_097) }));
    expectInvalid(validInput({ website: "w".repeat(201) }));
    expect(parse(validInput({ website: "bot-filled" })).website).toBe("bot-filled");
  });

  it("accepts boundary-sized text and rejects oversized or header-like fields", () => {
    expect(parse(validInput({ name: "N".repeat(80), company: "C".repeat(120) }))).toMatchObject({
      name: "N".repeat(80),
      company: "C".repeat(120),
    });
    expectInvalid(validInput({ name: "N".repeat(81) }));
    expectInvalid(validInput({ company: "C".repeat(121) }));
    expectInvalid(validInput({ email: `${"a".repeat(245)}@example.test` }));
    expectInvalid(validInput({ email: "ada@example.test\r\nBcc: victim@example.test" }));
  });

  it("strictly rejects missing and unknown properties", () => {
    const missing = validInput();
    delete missing.website;
    expectInvalid(missing);
    expectInvalid(validInput({ message: "free-form text is not accepted" }));
  });
});
