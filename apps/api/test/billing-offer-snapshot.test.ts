import { BadRequestException } from "@nestjs/common";
import type { Db } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import type { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingController } from "../src/modules/billing/billing.controller";
import type { BillingDocumentsService } from "../src/modules/billing/billing-documents.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

function resolvedQuery<T>(rows: T[]) {
  const promise = Promise.resolve(rows);
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    orderBy: vi.fn(() => query),
    limit: vi.fn(() => promise),
    then: promise.then.bind(promise),
  };
  return query;
}

describe("BillingService offer snapshots", () => {
  it("persists a source-offer custom line with literal descriptions and explicit no-VAT intent", async () => {
    const insertedValues: unknown[] = [];
    const invoice = {
      id: "31111111-1111-4111-8111-111111111111",
      tenantId: "21111111-1111-4111-8111-111111111111",
      number: "INV-000002",
    };
    let transactionSelect = 0;
    let insertCount = 0;
    const tx = {
      select: vi.fn(() => {
        transactionSelect += 1;
        return resolvedQuery(transactionSelect === 1 ? [{ number: "INV-000001" }] : []);
      }),
      insert: vi.fn(() => ({
        values: (values: unknown) => {
          insertedValues.push(values);
          insertCount += 1;
          const rows = insertCount === 1 ? [invoice] : [];
          const promise = Promise.resolve(rows);
          return { returning: vi.fn(async () => rows), then: promise.then.bind(promise) };
        },
      })),
      update: vi.fn(() => ({
        set: () => ({
          where: () => ({ returning: vi.fn(async () => [{ ...invoice, total: "99.00" }]) }),
        }),
      })),
    };
    const db = {
      select: vi.fn(() => resolvedQuery([{ id: invoice.tenantId }])),
      transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
    } as unknown as Db;
    const principal: PlatformPrincipal = {
      userId: "11111111-1111-4111-8111-111111111111",
      role: "accountant",
      capabilities: ["billing.write"],
      twoFactorReady: true,
    };

    await new BillingService(db, {} as PlatformAuditService).create(principal, {
      tenantId: invoice.tenantId,
      dueDate: null,
      applicationMode: "automatic",
      lines: [
        {
          kind: "custom",
          catalogVersionId: null,
          nameRu: "Согласованный тариф",
          nameEn: "Agreed plan",
          descriptionRu: "Особые условия поставки",
          descriptionEn: "Special delivery terms",
          quantity: 2,
          unit: "лицензия",
          catalogUnitPrice: "120.00",
          agreedUnitPrice: "49.50",
          vatRateBps: null,
          vatIncluded: false,
          activationPolicy: null,
        },
      ],
    });

    expect(insertedValues[1]).toMatchObject({
      kind: "custom",
      catalogVersionId: null,
      catalogKind: null,
      nameRu: "Согласованный тариф",
      nameEn: "Agreed plan",
      descriptionRu: "Особые условия поставки",
      descriptionEn: "Special delivery terms",
      unit: "лицензия",
      catalogUnitPrice: "120.00",
      agreedUnitPrice: "49.50",
      vatRate: null,
      vatIncluded: false,
      lineSubtotal: "99.00",
      lineVat: "0.00",
      lineTotal: "99.00",
    });
  });
});

describe("platform invoice response boundary", () => {
  it("rejects a malformed successful invoice list returned by the service", async () => {
    const billing = {
      list: async () => ({
        items: [
          {
            id: "31111111-1111-4111-8111-111111111111",
            tenantId: "21111111-1111-4111-8111-111111111111",
            number: "INV-000002",
            status: "draft",
            total: "99.00",
          },
        ],
      }),
    } as unknown as BillingService;
    const controller = new BillingController(
      billing,
      {} as BillingDocumentsService,
      {} as BillingApplicationService,
    );

    await expect(controller.list()).rejects.toThrow();
  });

  it("rejects a malformed document id before the document service", async () => {
    const documents = {
      url: vi.fn(async () => ({
        url: "https://objects.example.invalid/invoices/invoice.pdf?signature=redacted",
      })),
    } as unknown as BillingDocumentsService;
    const controller = new BillingController(
      {} as BillingService,
      documents,
      {} as BillingApplicationService,
    );

    const failure = await controller
      .documentDownload("31111111-1111-4111-8111-111111111111", "not-a-uuid")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BadRequestException);
    expect(documents.url).not.toHaveBeenCalled();
  });
});
