import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BillingProfilesController } from "../src/modules/billing-profiles/billing-profiles.controller";
import { BillingProfilesService } from "../src/modules/billing-profiles/billing-profiles.service";
import { listenOnLoopback } from "./support/listen-loopback";

describe("billing profiles HTTP contract", () => {
  let app: INestApplication;
  const createdAt = new Date("2026-08-23T06:00:00.000Z");
  const setOperator = vi.fn(async (_principal: unknown, body: Record<string, unknown>) => ({
    id: "00000000-0000-4000-8000-000000000621",
    ...body,
    ogrnip: null,
    legalAddress: null,
    actualSameAsLegal: true,
    actualAddressRaw: null,
    actualAddress: null,
    postalSameAsLegal: true,
    postalAddressRaw: null,
    postalAddress: null,
    isCurrent: true,
    revision: 1,
    isConfirmed: true,
    confirmedByPlatformUserId: "platform-admin",
    confirmedAt: createdAt,
    createdByPlatformUserId: "platform-admin",
    createdAt,
  }));
  const setTenant = vi.fn(
    async (_principal: unknown, tenantId: string, body: Record<string, unknown>) => ({
      id: "00000000-0000-4000-8000-000000000622",
      tenantId,
      ...body,
      inn: null,
      kpp: null,
      ogrn: null,
      ogrnip: null,
      legalAddress: null,
      actualSameAsLegal: true,
      actualAddressRaw: null,
      actualAddress: null,
      postalSameAsLegal: true,
      postalAddressRaw: null,
      postalAddress: null,
      isCurrent: true,
      revision: 1,
      isConfirmed: true,
      confirmedByPlatformUserId: "platform-admin",
      confirmedAt: createdAt,
      createdByPlatformUserId: "platform-admin",
      createdAt,
    }),
  );

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [BillingProfilesController],
      providers: [
        {
          provide: BillingProfilesService,
          useValue: {
            getOperator: async () => null,
            getTenant: async () => null,
            setOperator,
            setTenant,
          },
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(["/platform/billing/operator-profile", "/platform/billing/tenants/tenant-1/profile"])(
    "serializes an absent profile as JSON null at %s",
    async (path) => {
      const response = await request(app.getHttpServer()).get(path).expect(200);

      expect(response.headers["content-type"]).toMatch(/^application\/json\b/u);
      expect(response.text).toBe("null");
      expect(response.body).toBeNull();
    },
  );

  it("passes exact N-1 seller and tenant PUT bodies through with actualAddress omitted", async () => {
    const legacySeller = {
      kind: "legal_entity",
      fullName: "ООО Маркиро",
      displayName: "Маркиро",
      inn: "7700000000",
      kpp: "770001001",
      ogrn: "1027700000000",
      legalAddressRaw: "г Москва",
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
    };
    const legacyTenant = {
      kind: "individual",
      fullName: "Иванов Иван Иванович",
      displayName: "Иванов И. И.",
      legalAddressRaw: "г Казань",
      postalAddress: { sameAsLegal: true },
      contact: { name: null, email: null, phone: null },
    };

    await request(app.getHttpServer())
      .put("/platform/billing/operator-profile")
      .send(legacySeller)
      .expect(200);
    await request(app.getHttpServer())
      .put("/platform/billing/tenants/tenant-1/profile")
      .send(legacyTenant)
      .expect(200);

    expect(setOperator).toHaveBeenCalledWith(undefined, legacySeller);
    expect(setTenant).toHaveBeenCalledWith(undefined, "tenant-1", legacyTenant);
  });
});
