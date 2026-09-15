import { describe, expect, it } from "vitest";
import { catalogVersionV4Schema } from "@markiro/platform-contracts";
import { PlatformCatalogController } from "../src/modules/platform-catalog/platform-catalog.controller";
import type { PlatformCatalogService } from "../src/modules/platform-catalog/platform-catalog.service";

const recurringService = {
  id: "11111111-1111-4111-8111-111111111111",
  catalogItemId: "21111111-1111-4111-8111-111111111111",
  catalogItemCode: "support-monthly",
  kind: "service" as const,
  version: 1,
  status: "draft" as const,
  documentNameRu: "Техническая поддержка",
  documentNameEn: "Technical support",
  subject: "service" as const,
  sellerPolicyRevision: 1,
  lifecyclePolicyId: null,
  nameRu: "Поддержка",
  nameEn: "Support",
  descriptionRu: null,
  descriptionEn: null,
  unit: "month",
  billingMode: "recurring" as const,
  billingPeriod: "month" as const,
  unitPrice: "2000.00",
  vatRateBps: null,
  vatIncluded: false,
  publishedAt: null,
  publishedByPlatformUserId: null,
  service: {
    cadence: "month" as const,
    includedMinutes: 120,
    carryover: "none" as const,
    excessPolicy: "external_approval" as const,
    scopeRu: "Поддержка пользователей",
    scopeEn: "User support",
    operatingHoursRu: null,
    operatingHoursEn: null,
    schedulingTermsRu: null,
    schedulingTermsEn: null,
  },
};

function request(version: "3" | "4") {
  return {
    headers: { "x-markiro-commercial-version": version },
    platformPrincipal: {
      userId: "platform-user",
      role: "platform_admin",
      capabilities: ["catalog.read"],
      twoFactorReady: true,
    },
  } as never;
}

describe("commercial V4 catalog boundary", () => {
  it("returns recurring service terms only to a V4 client", async () => {
    const service = {
      list: async () => ({ items: [recurringService] }),
    } as unknown as PlatformCatalogService;
    const controller = new PlatformCatalogController(service);

    expect(catalogVersionV4Schema.parse((await controller.list(request("4"))).items[0])).toEqual(
      recurringService,
    );
    await expect(controller.list(request("3"))).rejects.toMatchObject({
      response: { code: "client_update_required" },
    });
  });
});
