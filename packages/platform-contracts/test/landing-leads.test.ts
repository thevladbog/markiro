import { describe, expect, it } from "vitest";

import {
  LANDING_LEAD_SOURCE_PATHS,
  landingLeadRequestSchema,
  platformLeadListQuerySchema,
  platformLeadUpdateSchema,
} from "../src/index.js";

const download = {
  requestId: "3f9b0f5e-2b8a-4b8e-9b40-1f6f3b2f5e11",
  locale: "ru",
  sourcePath: "/skachat/",
  intent: "download",
  email: " Buyer@Example.RU ",
  company: "ООО «Пивоварня»",
  consentVersion: "consent-v1",
  website: "",
  captchaToken: "token",
} as const;

describe("landing lead public contract (spec §15.3)", () => {
  it("lists exactly the three landing form paths", () => {
    expect(LANDING_LEAD_SOURCE_PATHS).toEqual(["/", "/skachat/", "/stoimost/"]);
  });

  it("accepts the short download form and normalizes the e-mail", () => {
    const parsed = landingLeadRequestSchema.parse(download);
    expect(parsed.email).toBe("buyer@example.ru");
    expect(parsed.inn).toBeUndefined();
  });

  it("treats empty optional form fields as absent", () => {
    const parsed = landingLeadRequestSchema.parse({
      ...download,
      name: "",
      phone: " ",
      inn: "",
      tariffCode: "",
      utm: { source: "yandex", medium: "" },
    });
    expect(parsed.name).toBeUndefined();
    expect(parsed.phone).toBeUndefined();
    expect(parsed.inn).toBeUndefined();
    expect(parsed.utm).toEqual({ source: "yandex", medium: undefined });
  });

  it("requires a valid INN and a tariff for an invoice request", () => {
    expect(landingLeadRequestSchema.safeParse({ ...download, intent: "invoice" }).success).toBe(
      false,
    );
    expect(
      landingLeadRequestSchema.safeParse({
        ...download,
        intent: "invoice",
        sourcePath: "/stoimost/",
        inn: "7707083893",
        tariffCode: "line",
      }).success,
    ).toBe(true);
    expect(
      landingLeadRequestSchema.safeParse({
        ...download,
        intent: "invoice",
        inn: "7707083894",
        tariffCode: "line",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown fields, paths and buckets", () => {
    for (const body of [
      { ...download, extra: true },
      { ...download, sourcePath: "/faq/" },
      { ...download, linesBucket: "5" },
      { ...download, utm: { source: "x", gclid: "y" } },
    ]) {
      expect(landingLeadRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("platform lead contracts", () => {
  it("coerces paging and filters", () => {
    expect(
      platformLeadListQuerySchema.parse({ page: "2", status: "new", from: "2026-10-01" }),
    ).toEqual({ page: 2, limit: 50, status: "new", from: "2026-10-01" });
    expect(platformLeadListQuerySchema.safeParse({ kind: "status_change" }).success).toBe(false);
  });

  it("refuses an empty update and a note over 2000 characters", () => {
    expect(platformLeadUpdateSchema.safeParse({}).success).toBe(false);
    expect(platformLeadUpdateSchema.safeParse({ ownerNote: "x".repeat(2001) }).success).toBe(false);
    expect(platformLeadUpdateSchema.parse({ ownerNote: null })).toEqual({ ownerNote: null });
  });
});
