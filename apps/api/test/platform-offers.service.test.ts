import { BadRequestException } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import type { CreateOfferDto } from "../src/modules/platform-offers/dto";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";

const actor: PlatformPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "accountant",
  capabilities: ["billing.write"],
  twoFactorReady: true,
};

const input: CreateOfferDto = {
  tenantId: "21111111-1111-4111-8111-111111111111",
  expiresAt: null,
  lines: [
    {
      kind: "plan",
      catalogVersionId: "31111111-1111-4111-8111-111111111111",
      nameRu: "Базовый",
      nameEn: "Basic",
      quantity: 1,
      unit: "месяц",
      catalogUnitPrice: "120.00",
      agreedUnitPrice: "120.00",
      vatRateBps: 2000,
      vatIncluded: true,
      priceOverrideReason: null,
      activationPolicy: "immediately",
    },
  ],
};

describe("PlatformOffersService catalog validation", () => {
  it("rejects a catalog version retired after the editor loaded it before inserting an offer", async () => {
    const insert = vi.fn();
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => query),
      for: vi.fn(async () => [{ kind: "plan", status: "retired" }]),
    };
    const tx = { select: vi.fn(() => query), insert };
    const db = {
      transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
    } as unknown as Db;

    const failure = await new PlatformOffersService(db)
      .create(actor, input)
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({
      code: "offer_catalog_version_invalid",
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
