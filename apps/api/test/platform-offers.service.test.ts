import { BadRequestException } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import { createOfferSchema, type CreateOfferDto } from "../src/modules/platform-offers/dto";
import type { OfferDocumentsService } from "../src/modules/platform-offers/offer-documents.service";
import { PlatformOffersController } from "../src/modules/platform-offers/platform-offers.controller";
import { PlatformOffersService } from "../src/modules/platform-offers/platform-offers.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

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
  version:
    | { kind: "plan" | "addon" | "service"; status: "published" | "retired"; unitPrice: string }
    | null
    | undefined = {
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
          for: vi.fn(async () => (version === null ? [] : [version])),
          limit: vi.fn(async () => [offer]),
          orderBy: vi.fn(async () => []),
        };
        return query;
      }
      const query = {
        from: vi.fn(() => query),
        where: vi.fn(() => query),
        limit: vi.fn(async () => (selectCount === 2 ? [offer] : [])),
        orderBy: vi.fn(async () => []),
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
  return {
    service: new PlatformOffersService(db, {} as PlatformAuditService),
    insertedValues,
    insert: tx.insert,
  };
}

describe("PlatformOffersService catalog validation", () => {
  it.each([
    [null, "plan", "offer_catalog_version_invalid"],
    [
      { kind: "plan", status: "retired", unitPrice: "120.00" },
      "plan",
      "offer_catalog_version_invalid",
    ],
    [
      { kind: "addon", status: "published", unitPrice: "120.00" },
      "plan",
      "offer_catalog_version_invalid",
    ],
  ] as const)("rejects invalid catalog state %#", async (version, kind, code) => {
    const { service, insert } = serviceHarness(version);
    const failure = await service
      .create(actor, { ...input, lines: [{ ...inputLine, kind }] })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({ code });
    expect(insert).not.toHaveBeenCalled();
  });

  it.each(["plan", "addon"] as const)("rejects an unversioned %s line", async (kind) => {
    const { service, insert } = serviceHarness();
    const failure = await service
      .create(actor, {
        ...input,
        lines: [{ ...inputLine, kind, catalogVersionId: null }],
      })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect((failure as BadRequestException).getResponse()).toEqual({
      code: "offer_catalog_version_invalid",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("accepts an unversioned service line", async () => {
    const { service, insertedValues } = serviceHarness();
    await service.create(actor, {
      ...input,
      lines: [
        {
          ...inputLine,
          kind: "service",
          catalogVersionId: null,
          agreedUnitPrice: "120.00",
          priceOverrideReason: null,
          activationPolicy: null,
        },
      ],
    });
    expect(insertedValues[1]).toEqual([
      expect.objectContaining({ catalogVersionId: null, catalogUnitPrice: null }),
    ]);
  });

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

describe("platform offer response boundary", () => {
  it("rejects a malformed successful offer list returned by the service", async () => {
    const service = {
      list: async () => [
        {
          id: "41111111-1111-4111-8111-111111111111",
          tenantId: input.tenantId,
          status: "draft",
          total: "120.00",
        },
      ],
    } as unknown as PlatformOffersService;
    const controller = new PlatformOffersController(service, {} as OfferDocumentsService);
    const request = {
      platformPrincipal: actor,
    } as unknown as Parameters<PlatformOffersController["list"]>[0];

    await expect(controller.list(request)).rejects.toThrow();
  });

  it("rejects a malformed document id before the document service", async () => {
    const documents = {
      url: vi.fn(async () => ({
        url: "https://objects.example.invalid/offers/offer.pdf?signature=redacted",
      })),
    } as unknown as OfferDocumentsService;
    const controller = new PlatformOffersController({} as PlatformOffersService, documents);

    const failure = await controller
      .documentsDownload("41111111-1111-4111-8111-111111111111", "not-a-uuid")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(documents.url).not.toHaveBeenCalled();
  });
});
