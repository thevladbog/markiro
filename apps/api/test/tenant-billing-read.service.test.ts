import type { Db } from "@markiro/db";
import { schema } from "@markiro/db";
import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  tenantBillingOverviewSchema,
  tenantInvoiceDetailSchema,
  tenantOfferDetailSchema,
} from "../src/modules/tenant-billing/dto";
import { TenantBillingReadService } from "../src/modules/tenant-billing/tenant-billing-read.service";

const tenantId = "21111111-1111-4111-8111-111111111111";
const foreignTenantId = "22222222-2222-4222-8222-222222222222";
const invoiceId = "31111111-1111-4111-8111-111111111111";
const offerId = "41111111-1111-4111-8111-111111111111";
const invoiceDocumentId = "51111111-1111-4111-8111-111111111111";
const offerDocumentId = "61111111-1111-4111-8111-111111111111";
const actId = "71111111-1111-4111-8111-111111111111";
const actDocumentId = "81111111-1111-4111-8111-111111111111";

type QueryCall = { table: unknown; where: unknown[]; limit?: number; offset?: number };

function queryDb(rowsFor: (table: unknown) => unknown[]) {
  const calls: QueryCall[] = [];
  const db = {
    select: vi.fn(() => {
      let table: unknown;
      const where: unknown[] = [];
      const query = {
        from: vi.fn((value: unknown) => {
          table = value;
          return query;
        }),
        where: vi.fn((condition: unknown) => {
          where.push(condition);
          return query;
        }),
        orderBy: vi.fn(() => query),
        limit: vi.fn(async (count: number) => {
          calls.push({ table, where, limit: count });
          return rowsFor(table).slice(0, count);
        }),
        offset: vi.fn((count: number) => {
          calls.push({ table, where, offset: count });
          return query;
        }),
        then: (resolve: (rows: unknown[]) => unknown) => {
          calls.push({ table, where });
          return Promise.resolve(rowsFor(table)).then(resolve);
        },
      };
      return query;
    }),
  } as unknown as Db;
  return { db, calls };
}

function conditionsFor(calls: QueryCall[], table: unknown) {
  return calls
    .filter((call) => call.table === table)
    .flatMap((call) => call.where)
    .flatMap((condition) => scalarValues(condition));
}

function scalarValues(value: unknown, seen = new WeakSet<object>()): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (!value || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  return Reflect.ownKeys(value).flatMap((key) => {
    try {
      return scalarValues(Reflect.get(value, key), seen);
    } catch {
      return [];
    }
  });
}

describe("TenantBillingReadService", () => {
  it("projects a partial invoice with ordered payments and exact payment summary", async () => {
    const { db } = queryDb((table) => {
      if (table === schema.invoices) {
        return [
          {
            id: invoiceId,
            tenantId,
            number: "INV-000001",
            status: "partially_paid",
            issueDate: new Date("2026-08-01T00:00:00.000Z"),
            dueDate: new Date("2026-08-20T00:00:00.000Z"),
            total: "48000.00",
            currency: "RUB",
          },
        ];
      }
      if (table === schema.billingPayments) {
        return [
          {
            id: "91111111-1111-4111-8111-111111111111",
            tenantId,
            invoiceId,
            amount: "20000.00",
            currency: "RUB",
            paidAt: new Date("2026-08-21T00:00:00.000Z"),
          },
        ];
      }
      return [];
    });
    const service = new TenantBillingReadService(db, {} as never, {} as never);

    await expect(service.invoiceDetail(tenantId, invoiceId)).resolves.toMatchObject({
      id: invoiceId,
      status: "overdue",
      payments: [
        {
          id: "91111111-1111-4111-8111-111111111111",
          amount: "20000.00",
          currency: "RUB",
        },
      ],
      paymentSummary: {
        confirmedAmount: "20000.00",
        remainingAmount: "28000.00",
        status: "partially_paid",
      },
    });
  });

  it("scopes every entity detail and download lookup to its tenant", async () => {
    const { db, calls } = queryDb((table) => {
      if (table === schema.invoices)
        return [{ id: invoiceId, tenantId, status: "issued", total: "1.00" }];
      if (table === schema.commercialOffers)
        return [{ id: offerId, tenantId, status: "published", total: "1.00" }];
      if (table === schema.invoiceDocuments) {
        return [
          {
            id: invoiceDocumentId,
            tenantId,
            invoiceId,
            status: "ready",
            objectKey: `tenants/${tenantId}/invoices/${invoiceId}/r1.pdf`,
          },
        ];
      }
      if (table === schema.commercialOfferDocuments) {
        return [
          {
            id: offerDocumentId,
            tenantId,
            offerId,
            status: "ready",
            objectKey: `tenants/${tenantId}/offers/${offerId}/r1.pdf`,
          },
        ];
      }
      if (table === schema.billingActs) return [{ id: actId, tenantId, status: "issued" }];
      if (table === schema.billingActDocuments) {
        return [
          {
            id: actDocumentId,
            tenantId,
            actId,
            objectKey: `tenants/${tenantId}/acts/${actId}/r1.pdf`,
          },
        ];
      }
      return [];
    });
    const storage = { presignRead: vi.fn(async () => "https://private.example.test/document") };
    const service = new TenantBillingReadService(db, storage as never, {} as never);

    await service.invoiceDetail(tenantId, invoiceId);
    await service.offerDetail(tenantId, offerId);
    await service.downloadInvoiceDocument(tenantId, invoiceId, invoiceDocumentId);
    await service.downloadOfferDocument(tenantId, offerId, offerDocumentId);
    await service.downloadActDocument(tenantId, actId, actDocumentId);

    for (const table of [
      schema.invoices,
      schema.commercialOffers,
      schema.invoiceDocuments,
      schema.commercialOfferDocuments,
      schema.billingActDocuments,
    ]) {
      expect(conditionsFor(calls, table).join(" ")).toContain(tenantId);
    }
    expect(conditionsFor(calls, schema.invoices).join(" ")).toContain(invoiceId);
    expect(conditionsFor(calls, schema.commercialOffers).join(" ")).toContain(offerId);
    expect(conditionsFor(calls, schema.invoiceDocuments).join(" ")).toContain(invoiceDocumentId);
    expect(conditionsFor(calls, schema.commercialOfferDocuments).join(" ")).toContain(
      offerDocumentId,
    );
    expect(conditionsFor(calls, schema.billingActDocuments).join(" ")).toContain(actDocumentId);
    expect(conditionsFor(calls, schema.billingActDocuments).join(" ")).toContain(actId);
    expect(storage.presignRead).toHaveBeenCalledWith(
      `tenants/${tenantId}/invoices/${invoiceId}/r1.pdf`,
      300,
    );
    expect(storage.presignRead).toHaveBeenCalledWith(
      `tenants/${tenantId}/offers/${offerId}/r1.pdf`,
      300,
    );
    expect(storage.presignRead).toHaveBeenCalledWith(
      `tenants/${tenantId}/acts/${actId}/r1.pdf`,
      300,
    );
    expect(foreignTenantId).not.toBe(tenantId);
  });

  it("does not sign a tenant-scoped row with a foreign entity key", async () => {
    const { db } = queryDb((table) => {
      if (table === schema.invoiceDocuments) {
        return [
          {
            id: invoiceDocumentId,
            tenantId,
            invoiceId,
            status: "ready",
            objectKey: `tenants/${tenantId}/invoices/31111111-1111-4111-8111-111111111112/r1.pdf`,
          },
        ];
      }
      return [];
    });
    const storage = { presignRead: vi.fn() };
    const service = new TenantBillingReadService(db, storage as never, {} as never);

    await expect(
      service.downloadInvoiceDocument(tenantId, invoiceId, invoiceDocumentId),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(storage.presignRead).not.toHaveBeenCalled();
  });

  it("pushes invoice offsets and enough merged document rows to the database boundary", async () => {
    const { db, calls } = queryDb((table) => {
      if (table === schema.invoices) return [];
      if (table === schema.commercialOfferDocuments || table === schema.billingActDocuments)
        return [];
      return [];
    });
    const service = new TenantBillingReadService(db, {} as never, {} as never);

    await service.listInvoices(tenantId, { limit: 25, offset: 150, status: "overdue" });
    await service.listDocuments(tenantId, { limit: 25, offset: 150 });

    expect(calls).toContainEqual(expect.objectContaining({ table: schema.invoices, offset: 150 }));
    expect(calls).toContainEqual(expect.objectContaining({ table: schema.invoices, limit: 25 }));
    for (const table of [schema.commercialOfferDocuments, schema.billingActDocuments]) {
      expect(calls).toContainEqual(expect.objectContaining({ table, offset: 0 }));
      expect(calls).toContainEqual(expect.objectContaining({ table, limit: 175 }));
    }
  });

  it("rejects unknown persisted workflow states at the DTO boundary", () => {
    const invalidRequest = { id: invoiceId, number: "REQ-1", status: "invented" };
    expect(
      tenantInvoiceDetailSchema.safeParse({
        id: invoiceId,
        number: "INV-1",
        status: "issued",
        issueDate: null,
        dueDate: null,
        total: "1.00",
        currency: "RUB",
        paymentSummary: null,
        subtotal: "1.00",
        vatTotal: "0.00",
        payments: [],
        lines: [],
        documents: [],
        request: invalidRequest,
      }).success,
    ).toBe(false);
    expect(
      tenantOfferDetailSchema.safeParse({
        id: offerId,
        number: "OFR-1",
        status: "published",
        total: "1.00",
        expiresAt: null,
        publishedAt: null,
        paidAt: null,
        termsMarkdown: null,
        lines: [],
        documents: [],
        request: invalidRequest,
      }).success,
    ).toBe(false);
    expect(
      tenantBillingOverviewSchema.safeParse({
        subscription: null,
        scheduledSubscription: null,
        access: "unmanaged",
        limits: {
          lines: null,
          stations: null,
          kiosks: null,
          cabinetUsers: null,
          labelEditor: true,
          publicApi: true,
          pallets: true,
        },
        usage: { lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 },
        limitPresentation: {
          lines: { used: 0, assigned: null, remaining: null, state: "normal" },
          stations: { used: 0, assigned: null, remaining: null, state: "normal" },
          kiosks: { used: 0, assigned: null, remaining: null, state: "normal" },
          cabinetUsers: { used: 0, assigned: null, remaining: null, state: "normal" },
        },
        addons: [],
        services: [],
        actionableOffer: null,
        recentOperations: [
          {
            id: invoiceId,
            kind: "invoice",
            status: "unknown",
            occurredAt: "2026-08-27T00:00:00.000Z",
            label: "INV-1",
          },
        ],
        activeRequest: null,
        attentionCount: 0,
      }).success,
    ).toBe(false);
  });
});
