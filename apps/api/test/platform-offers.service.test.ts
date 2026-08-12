import { BadRequestException } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import { createOfferSchema, type CreateOfferDto } from "../src/modules/platform-offers/dto";
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
      agreedUnitPrice: "120.00",
      vatRateBps: 2000,
      vatIncluded: true,
      priceOverrideReason: null,
      activationPolicy: "immediately",
    },
  ],
};
const inputLine = input.lines[0]!;

function serviceHarness(
  version: { kind: "plan"; status: "published" | "retired"; unitPrice: string } = {
    kind: "plan",
    status: "published",
    unitPrice: "120.00",
  },
) {
  const insertedValues: unknown[] = [];
  const offer = { id: "41111111-1111-4111-8111-111111111111", tenantId: input.tenantId };
  let selectCount = 0;
  let insertCount = 0;
  const tx = {
    select: vi.fn(() => {
      selectCount += 1;
      if (selectCount === 1) {
        const query = {
          from: vi.fn(() => query),
          where: vi.fn(() => query),
          for: vi.fn(async () => [version]),
        };
        return query;
      }
      const rows = selectCount === 2 ? [offer] : [];
      const promise = Promise.resolve(rows);
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(() => promise),
        orderBy: vi.fn(() => promise),
      };
      return query;
    }),
    insert: vi.fn(() => ({
      values: (values: unknown) => {
        insertedValues.push(values);
        insertCount += 1;
        if (insertCount === 1) return { returning: vi.fn(async () => [offer]) };
        return Promise.resolve();
      },
    })),
  };
  const db = {
    transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
  } as unknown as Db;
  return { service: new PlatformOffersService(db), insertedValues, insert: tx.insert };
}

describe("PlatformOffersService catalog validation", () => {
  it.each([null, "1.00"])(
    "rejects a client-supplied catalog baseline of %s at the request boundary",
    (catalogUnitPrice) => {
      const candidate = { ...input, lines: [{ ...inputLine, catalogUnitPrice }] };
      expect(createOfferSchema.safeParse(candidate).success).toBe(false);
    },
  );

  it.each([undefined, null, "   "])(
    "rejects an authoritative price override with a missing or blank reason (%s)",
    async (priceOverrideReason) => {
      const { service, insert } = serviceHarness();
      const overrideInput: CreateOfferDto = {
        ...input,
        lines: [{ ...inputLine, agreedUnitPrice: "99.00", priceOverrideReason }],
      };
      const failure = await service.create(actor, overrideInput).catch((error) => error);
      expect(failure).toBeInstanceOf(BadRequestException);
      expect((failure as BadRequestException).getResponse()).toEqual({
        code: "offer_price_override_reason_required",
      });
      expect(insert).not.toHaveBeenCalled();
    },
  );

  it("persists the authoritative catalog baseline and a valid override reason", async () => {
    const { service, insertedValues } = serviceHarness();
    await service.create(actor, {
      ...input,
      lines: [
        {
          ...inputLine,
          agreedUnitPrice: "99.00",
          priceOverrideReason: "  Annual commitment  ",
        },
      ],
    });
    expect(insertedValues[1]).toEqual([
      expect.objectContaining({
        catalogVersionId: inputLine.catalogVersionId,
        catalogUnitPrice: "120.00",
        agreedUnitPrice: "99.00",
        priceOverrideReason: "Annual commitment",
      }),
    ]);
  });
});
