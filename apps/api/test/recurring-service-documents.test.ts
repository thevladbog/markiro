import { BadRequestException, ConflictException } from "@nestjs/common";
import type { schema } from "@markiro/db";
import { describe, expect, it } from "vitest";

import {
  commercialTermDescription,
  freezeCommercialLineTerms,
} from "../src/modules/billing/commercial-line-terms";
import { toOfferPrintModel } from "../src/modules/billing/print-document-model";

const serviceTerms = {
  cadence: "month" as const,
  includedMinutes: 180,
  carryover: "none" as const,
  excessPolicy: "external_approval" as const,
  scopeRu: "Консультации и настройка Маркиро",
  scopeEn: "Markiro consulting and configuration",
  operatingHoursRu: null,
  operatingHoursEn: null,
  schedulingTermsRu: "По согласованной заявке",
  schedulingTermsEn: "By an approved request",
};

const version = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  kind: "service" as const,
  version: 1,
  status: "published" as const,
  documentNameRu: "Абонентское сопровождение",
  documentNameEn: "Monthly support",
  subject: "service" as const,
  sellerPolicyRevision: 3,
  lifecyclePolicyId: null,
  nameRu: "Поддержка",
  nameEn: "Support",
  descriptionRu: null,
  descriptionEn: null,
  unit: "month",
  billingMode: "recurring" as const,
  billingPeriod: "month" as const,
  serviceTerms,
  unitPrice: "30000.00",
  vatRate: null,
  vatIncluded: false,
  publishedAt: new Date("2026-09-14T00:00:00.000Z"),
  publishedByPlatformUserId: "platform-user",
  createdAt: new Date("2026-09-14T00:00:00.000Z"),
  updatedAt: new Date("2026-09-14T00:00:00.000Z"),
} satisfies typeof schema.catalogItemVersions.$inferSelect;

const line = {
  kind: "service",
  quantity: 1,
  activationPolicy: null,
};

describe("recurring service commercial documents", () => {
  it("freezes the complete monthly policy and renders only declared Russian terms", () => {
    const frozen = freezeCommercialLineTerms(version, line);
    expect(frozen).toEqual({
      version: 2,
      subject: "service",
      documentNameRu: "Абонентское сопровождение",
      documentNameEn: "Monthly support",
      sellerPolicyRevision: 3,
      billingPeriod: "month",
      billingTimezone: "Europe/Moscow",
      activationRule: "after_current",
      serviceTerms,
    });

    const description = commercialTermDescription(frozen, null);
    expect(description).toContain("180 минут в месяц");
    expect(description).toContain(serviceTerms.scopeRu);
    expect(description).toContain(serviceTerms.schedulingTermsRu);
    expect(description).toContain("Неиспользованные минуты не переносятся");
    expect(description).toContain("после отдельного согласования");
    expect(description).not.toContain("24/7");
    expect(description).not.toContain("Часы работы:");
  });

  it("uses the stored policy when rebuilding an offer print model", () => {
    const frozen = freezeCommercialLineTerms(version, line);
    const model = toOfferPrintModel({
      number: "OFF-1",
      status: "published",
      publishedAt: new Date("2026-09-14T00:00:00.000Z"),
      expiresAt: null,
      sellerSnapshot: {},
      buyerSnapshot: {},
      linesSnapshot: [
        {
          position: 1,
          commercialTerms: frozen,
          nameRu: "Изменённое имя каталога",
          descriptionRu: null,
          unit: "service",
          quantity: 1,
          agreedUnitPrice: "30000.00",
          vatRate: null,
          vatIncluded: false,
          lineTotal: "30000.00",
        },
      ],
      subtotal: "30000.00",
      vatTotal: "0.00",
      total: "30000.00",
      termsHtml: null,
    });

    expect(model.lines[0]).toMatchObject({
      name: "Абонентское сопровождение",
      unit: "мес.",
      commercialTerms: frozen,
    });
    expect(model.lines[0]?.description).toContain(serviceTerms.scopeRu);
  });

  it("rejects quantity greater than one and a stale supplied policy", () => {
    expect(() => freezeCommercialLineTerms(version, { ...line, quantity: 2 })).toThrow(
      BadRequestException,
    );
    const frozen = freezeCommercialLineTerms(version, line);
    expect(() =>
      freezeCommercialLineTerms(
        { ...version, serviceTerms: { ...serviceTerms, includedMinutes: 240 } },
        { ...line, commercialTerms: frozen },
      ),
    ).toThrow(ConflictException);
  });
});
