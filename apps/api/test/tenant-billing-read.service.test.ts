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
  const select = vi.fn(() => {
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
  });
  const db = {
    execute: vi.fn(async () => ({ rows: [] })),
    select,
    transaction: vi.fn(async (run: (tx: { select: typeof select }) => Promise<unknown>) =>
      run({ select }),
    ),
  } as unknown as Db;
  return { db, calls };
}

function concurrentlyPaidInvoiceDb() {
  const issuedInvoice = {
    id: invoiceId,
    tenantId,
    number: "INV-000001",
    status: "issued" as const,
    issueDate: new Date("2026-08-01T00:00:00.000Z"),
    dueDate: new Date("2030-08-20T00:00:00.000Z"),
    subtotal: "48000.00",
    vatTotal: "0.00",
    total: "48000.00",
  };
  const confirmedPayment = {
    id: "91111111-1111-4111-8111-111111111111",
    tenantId,
    invoiceId,
    amount: "48000.00",
    paidAt: new Date("2026-08-27T09:00:00.000Z"),
  };
  let committed = {
    invoice: issuedInvoice as Record<string, unknown>,
    payments: [] as Array<typeof confirmedPayment>,
  };
  let paymentCommittedDuringRead = false;

  const makeSelect = (snapshot: typeof committed | undefined, commitAfterInvoiceRead: boolean) => {
    let table: unknown;
    let invoiceRead = false;
    const rows = () => {
      const state = snapshot ?? committed;
      if (table === schema.invoices) return [state.invoice];
      if (table === schema.billingPayments) return state.payments;
      return [];
    };
    const query = {
      from: vi.fn((value: unknown) => {
        table = value;
        return query;
      }),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      offset: vi.fn(() => query),
      limit: vi.fn(async (count: number) => {
        const result = rows().slice(0, count);
        if (table === schema.invoices && commitAfterInvoiceRead && !invoiceRead) {
          invoiceRead = true;
          paymentCommittedDuringRead = true;
          committed = {
            invoice: { ...issuedInvoice, status: "paid" },
            payments: [confirmedPayment],
          };
        }
        return result;
      }),
      then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows()).then(resolve, reject),
    };
    return query;
  };
  const transaction = vi.fn(
    async (
      run: (tx: { select: ReturnType<typeof vi.fn> }) => Promise<unknown>,
      _config?: { isolationLevel?: string; accessMode?: string },
    ) => {
      const snapshot = { invoice: { ...committed.invoice }, payments: [...committed.payments] };
      return run({ select: vi.fn(() => makeSelect(snapshot, true)) });
    },
  );
  const db = {
    select: vi.fn(() => makeSelect(undefined, true)),
    transaction,
  } as unknown as Db;
  return {
    db,
    transaction,
    paymentCommittedDuringRead: () => paymentCommittedDuringRead,
  };
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

class FixedClockTenantBillingReadService extends TenantBillingReadService {
  constructor(db: Db, entitlements: ConstructorParameters<typeof TenantBillingReadService>[2]) {
    super(db, {} as never, entitlements);
  }

  protected now(): Date {
    return new Date("2020-01-01T00:00:00.000Z");
  }
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

  it("keeps invoice list status and payment summary in one read snapshot", async () => {
    const { db, transaction, paymentCommittedDuringRead } = concurrentlyPaidInvoiceDb();
    const service = new TenantBillingReadService(db, {} as never, {} as never);

    const result = await service.listInvoices(tenantId, { limit: 25, offset: 0 });

    expect(paymentCommittedDuringRead()).toBe(true);
    expect(result.items).toEqual([
      expect.objectContaining({
        id: invoiceId,
        status: "issued",
        paymentSummary: {
          confirmedAmount: "0.00",
          remainingAmount: "48000.00",
          status: "issued",
        },
      }),
    ]);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("keeps invoice detail status and payments in one read snapshot", async () => {
    const { db, transaction, paymentCommittedDuringRead } = concurrentlyPaidInvoiceDb();
    const service = new TenantBillingReadService(db, {} as never, {} as never);

    const result = await service.invoiceDetail(tenantId, invoiceId);

    expect(paymentCommittedDuringRead()).toBe(true);
    expect(result).toMatchObject({
      id: invoiceId,
      status: "issued",
      payments: [],
      paymentSummary: {
        confirmedAmount: "0.00",
        remainingAmount: "48000.00",
        status: "issued",
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
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
            state: "ready",
            objectKey: `tenant-billing/${tenantId}/acts/${actId}/${actDocumentId}.pdf`,
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
      `tenant-billing/${tenantId}/acts/${actId}/${actDocumentId}.pdf`,
      300,
    );
    expect(foreignTenantId).not.toBe(tenantId);
  });

  it("downloads ready acts for safe public tenant IDs containing dots and colons", async () => {
    const safeTenantId = "factory.eu:primary";
    const { db } = queryDb((table) => {
      if (table === schema.billingActs) {
        return [{ id: actId, tenantId: safeTenantId, status: "issued" }];
      }
      if (table === schema.billingActDocuments) {
        return [
          {
            id: actDocumentId,
            tenantId: safeTenantId,
            actId,
            state: "ready",
            objectKey: `tenant-billing/${safeTenantId}/acts/${actId}/${actDocumentId}.pdf`,
          },
        ];
      }
      return [];
    });
    const storage = { presignRead: vi.fn(async () => "https://private.example.test/document") };
    const service = new TenantBillingReadService(db, storage as never, {} as never);

    await expect(service.downloadActDocument(safeTenantId, actId, actDocumentId)).resolves.toEqual({
      url: "https://private.example.test/document",
    });
    expect(storage.presignRead).toHaveBeenCalledWith(
      `tenant-billing/${safeTenantId}/acts/${actId}/${actDocumentId}.pdf`,
      300,
    );
  });

  it("does not sign poisoned invoice, offer, or act keys", async () => {
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
      if (table === schema.commercialOfferDocuments) {
        return [
          {
            id: offerDocumentId,
            tenantId,
            offerId,
            status: "ready",
            objectKey: `tenants/${foreignTenantId}/offers/${offerId}/r1.pdf`,
          },
        ];
      }
      if (table === schema.billingActDocuments) {
        return [
          {
            id: actDocumentId,
            tenantId,
            actId,
            state: "ready",
            objectKey: `tenant-billing/${tenantId}/acts/${actId}/${actDocumentId}.pdf.bak`,
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
    await expect(
      service.downloadOfferDocument(tenantId, offerId, offerDocumentId),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.downloadActDocument(tenantId, actId, actDocumentId),
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
  });

  it("returns the nearest future scheduled subscription at the service clock", async () => {
    const currentId = "31111111-1111-4111-8111-111111111121";
    const nearId = "31111111-1111-4111-8111-111111111122";
    const farId = "31111111-1111-4111-8111-111111111123";
    const currentPlanId = "41111111-1111-4111-8111-111111111121";
    const nearPlanId = "41111111-1111-4111-8111-111111111122";
    const farPlanId = "41111111-1111-4111-8111-111111111123";
    const { db } = queryDb((table) => {
      if (table === schema.tenantSubscriptions) {
        return [
          {
            id: currentId,
            tenantId,
            planVersionId: currentPlanId,
            status: "active",
            startsAt: new Date("2019-01-01T00:00:00.000Z"),
            endsAt: new Date("2030-01-01T00:00:00.000Z"),
          },
          {
            id: farId,
            tenantId,
            planVersionId: farPlanId,
            status: "scheduled",
            startsAt: new Date("2020-01-03T00:00:00.000Z"),
            endsAt: new Date("2020-02-03T00:00:00.000Z"),
          },
          {
            id: nearId,
            tenantId,
            planVersionId: nearPlanId,
            status: "scheduled",
            startsAt: new Date("2020-01-02T00:00:00.000Z"),
            endsAt: new Date("2020-02-02T00:00:00.000Z"),
          },
        ];
      }
      if (table === schema.catalogItemVersions) {
        return [
          {
            id: currentPlanId,
            nameRu: "Current",
            billingPeriod: "month",
            unitPrice: "1000.00",
          },
          {
            id: nearPlanId,
            nameRu: "Near",
            billingPeriod: "month",
            unitPrice: "2000.00",
          },
          {
            id: farPlanId,
            nameRu: "Far",
            billingPeriod: "year",
            unitPrice: "3000.00",
          },
        ];
      }
      return [];
    });
    const entitlements = {
      resolve: vi.fn(async () => ({
        tenantId,
        access: "managed" as const,
        subscription: {
          id: currentId,
          planVersionId: currentPlanId,
          status: "active" as const,
          startsAt: new Date("2019-01-01T00:00:00.000Z"),
          endsAt: new Date("2030-01-01T00:00:00.000Z"),
        },
        quotas: { lines: 1, stations: 1, kiosks: 1, cabinetUsers: 1 },
        features: { labelEditor: false, publicApi: false, pallets: false },
      })),
      usage: vi.fn(async () => ({ lines: 0, stations: 0, kiosks: 0, cabinetUsers: 0 })),
    };
    const service = new FixedClockTenantBillingReadService(db, entitlements as never);

    await expect(service.subscription(tenantId)).resolves.toMatchObject({
      subscription: { id: currentId, status: "active" },
      scheduledSubscription: {
        id: nearId,
        planVersionId: nearPlanId,
        status: "scheduled",
        startsAt: "2020-01-02T00:00:00.000Z",
        planName: "Near",
        billingPeriod: "month",
        price: "2000.00",
      },
    });
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
        isCurrent: true,
        actionable: true,
        latestDecision: null,
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
