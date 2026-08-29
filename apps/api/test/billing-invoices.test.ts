import type { Db } from "@markiro/db";
import { schema } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import { BillingService } from "../src/modules/billing/billing.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";
import { noopTenantBillingNotifications } from "./support/tenant-billing-notifications";

function queryFor(rowsFor: (table: unknown, ordered: boolean) => unknown[]) {
  let table: unknown;
  let ordered = false;
  const query = {
    from: vi.fn((value: unknown) => {
      table = value;
      return query;
    }),
    innerJoin: vi.fn(() => query),
    where: vi.fn(() => query),
    for: vi.fn(() => query),
    orderBy: vi.fn(() => {
      ordered = true;
      return query;
    }),
    limit: vi.fn(async () => rowsFor(table, ordered).slice(0, 1)),
    then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(rowsFor(table, ordered)).then(resolve, reject),
  };
  return query;
}

describe("BillingService invoice payment detail", () => {
  const principal: PlatformPrincipal = {
    userId: "platform-accountant",
    role: "accountant",
    capabilities: ["billing.read", "billing.write"],
    twoFactorReady: true,
  };

  it("joins tenant display names into the platform invoice registry", async () => {
    const invoice = {
      id: "31111111-1111-4111-8111-111111111111",
      tenantId: "21111111-1111-4111-8111-111111111111",
      tenantName: "ООО Фабрика",
      status: "draft" as const,
    };
    const select = vi.fn(() => queryFor(() => [invoice]));
    const db = Object.assign(Object.create(null), { select }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    await expect(service.list()).resolves.toEqual({ items: [invoice] });
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ tenantName: schema.organization.name }),
    );
  });

  it("returns ordered confirmed payments and an exact partial-payment summary", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const tenantId = "21111111-1111-4111-8111-111111111111";
    const first = {
      id: "51111111-1111-4111-8111-111111111112",
      tenantId,
      invoiceId,
      paidAt: new Date("2026-08-27T09:00:00.000Z"),
      amount: "12000.00",
    };
    const second = {
      id: "51111111-1111-4111-8111-111111111111",
      tenantId,
      invoiceId,
      paidAt: new Date("2026-08-27T09:00:00.000Z"),
      amount: "8000.00",
    };
    const invoice = {
      id: invoiceId,
      tenantId,
      status: "partially_paid" as const,
      total: "48000.00",
    };
    const rowsFor = (table: unknown, ordered: boolean) => {
      if (table === schema.invoices) return [invoice];
      if (table === schema.billingPayments) {
        return ordered ? [second, first] : [first, second];
      }
      return [];
    };
    const db = Object.assign(Object.create(null), {
      select: vi.fn(() => queryFor(rowsFor)),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({ select: vi.fn(() => queryFor(rowsFor)) }),
      ),
    }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    const detail = await service.get(invoiceId);

    expect(detail.payments.map((payment) => payment.id)).toEqual([second.id, first.id]);
    expect(detail.paymentSummary).toEqual({
      confirmedAmount: "20000.00",
      remainingAmount: "28000.00",
      status: "partially_paid",
    });
    expect(detail.application.status).toBe("not_paid");
    expect(detail).not.toHaveProperty("payment");
  });

  it("does not cancel an invoice after a confirmed partial payment", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const invoice = {
      id: invoiceId,
      tenantId: "21111111-1111-4111-8111-111111111111",
      status: "partially_paid" as const,
      total: "48000.00",
    };
    const rowsFor = (table: unknown) => (table === schema.invoices ? [invoice] : []);
    const db = Object.assign(Object.create(null), {
      select: vi.fn(() => queryFor(rowsFor)),
      update: vi.fn(),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: vi.fn(async () => ({ rows: [] })),
          select: vi.fn(() => queryFor(rowsFor)),
          update: vi.fn(),
        }),
      ),
    }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    await expect(service.cancel({} as PlatformPrincipal, invoiceId)).rejects.toMatchObject({
      response: { code: "invoice_paid" },
    });
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not turn an unissued draft into a contract-invalid cancelled invoice", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const invoice = {
      id: invoiceId,
      tenantId: "21111111-1111-4111-8111-111111111111",
      number: "INV-000021",
      status: "draft" as const,
    };
    const rowsFor = (table: unknown) => (table === schema.invoices ? [invoice] : []);
    const update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [{ ...invoice, status: "cancelled" }]),
        })),
      })),
    }));
    const db = Object.assign(Object.create(null), {
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: vi.fn(async () => ({ rows: [] })),
          select: vi.fn(() => queryFor(rowsFor)),
          update,
        }),
      ),
    }) as Db;
    const audit = { record: vi.fn() } as unknown as PlatformAuditService;
    const service = new BillingService(db, audit, noopTenantBillingNotifications());

    await expect(service.cancel(principal, invoiceId)).rejects.toMatchObject({
      response: { code: "invoice_not_issued" },
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("withdraws an issued invoice and records the exact audit transition", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const tenantId = "21111111-1111-4111-8111-111111111111";
    const invoice = { id: invoiceId, tenantId, number: "INV-000021", status: "issued" as const };
    const rowsFor = (table: unknown) => (table === schema.invoices ? [invoice] : []);
    const update = vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [
            { ...invoice, status: "cancelled", cancelledAt: new Date() },
          ]),
        })),
      })),
    }));
    const audit = { record: vi.fn(async () => undefined) };
    const db = Object.assign(Object.create(null), {
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: vi.fn(async () => ({ rows: [] })),
          select: vi.fn(() => queryFor(rowsFor)),
          update,
        }),
      ),
    }) as Db;
    const service = new BillingService(
      db,
      audit as unknown as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    await expect(service.cancel(principal, invoiceId)).resolves.toMatchObject({
      status: "cancelled",
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "billing.invoice.cancelled",
        tenantId,
        targetId: invoiceId,
        before: { status: "issued", number: invoice.number },
        after: expect.objectContaining({ status: "cancelled" }),
      }),
    );
  });

  it("deletes only a clean draft with its internal lines and records an audit event", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const tenantId = "21111111-1111-4111-8111-111111111111";
    const invoice = { id: invoiceId, tenantId, number: "INV-000021", status: "draft" as const };
    const rowsFor = (table: unknown) => (table === schema.invoices ? [invoice] : []);
    const deletedTables: unknown[] = [];
    const remove = vi.fn((table: unknown) => {
      deletedTables.push(table);
      return {
        where: vi.fn(() =>
          table === schema.invoices
            ? { returning: vi.fn(async () => [invoice]) }
            : Promise.resolve([]),
        ),
      };
    });
    const audit = { record: vi.fn(async () => undefined) };
    const db = Object.assign(Object.create(null), {
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: vi.fn(async () => ({ rows: [] })),
          select: vi.fn(() => queryFor(rowsFor)),
          delete: remove,
        }),
      ),
    }) as Db;
    const service = new BillingService(
      db,
      audit as unknown as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    const result = await (
      service as BillingService & {
        deleteDraft: (
          actor: PlatformPrincipal,
          id: string,
        ) => Promise<{ id: string; tenantId: string; number: string; deleted: true }>;
      }
    ).deleteDraft(principal, invoiceId);

    expect(result).toEqual({ id: invoiceId, tenantId, number: invoice.number, deleted: true });
    expect(deletedTables).toEqual([schema.invoiceLines, schema.invoices]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "billing.invoice.deleted",
        tenantId,
        targetType: "invoice",
        targetId: invoiceId,
        before: { status: "draft", number: invoice.number },
        after: { deleted: true },
      }),
    );
  });

  it("keeps a draft that is linked to a tenant billing request", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const invoice = {
      id: invoiceId,
      tenantId: "21111111-1111-4111-8111-111111111111",
      number: "INV-000021",
      status: "draft" as const,
    };
    const rowsFor = (table: unknown) => {
      if (table === schema.invoices) return [invoice];
      if (table === schema.tenantBillingRequestLinks) return [{ id: "linked-request" }];
      return [];
    };
    const remove = vi.fn();
    const db = Object.assign(Object.create(null), {
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
        run({
          execute: vi.fn(async () => ({ rows: [] })),
          select: vi.fn(() => queryFor(rowsFor)),
          delete: remove,
        }),
      ),
    }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    await expect(service.deleteDraft(principal, invoiceId)).rejects.toMatchObject({
      response: { code: "invoice_has_dependencies" },
      status: 409,
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("keeps invoice status and payment aggregate in one read snapshot", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const tenantId = "21111111-1111-4111-8111-111111111111";
    const issuedInvoice = {
      id: invoiceId,
      tenantId,
      status: "issued" as const,
      total: "48000.00",
    };
    const partialPayment = {
      id: "51111111-1111-4111-8111-111111111111",
      tenantId,
      invoiceId,
      paidAt: new Date("2026-08-27T09:00:00.000Z"),
      amount: "20000.00",
    };
    let committed = {
      invoice: issuedInvoice as Record<string, unknown>,
      payments: [] as unknown[],
    };
    let paymentCommittedDuringRead = false;

    const makeSelect = (
      snapshot: typeof committed | undefined,
      commitAfterInvoiceRead: boolean,
    ) => {
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
        innerJoin: vi.fn(() => query),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(async () => {
          const result = rows().slice(0, 1);
          if (table === schema.invoices && commitAfterInvoiceRead && !invoiceRead) {
            invoiceRead = true;
            paymentCommittedDuringRead = true;
            committed = {
              invoice: { ...issuedInvoice, status: "partially_paid" },
              payments: [partialPayment],
            };
          }
          return result;
        }),
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows()).then(resolve),
      };
      return query;
    };
    const db = Object.assign(Object.create(null), {
      select: vi.fn(() => makeSelect(undefined, true)),
      transaction: vi.fn(
        async (
          run: (tx: unknown) => Promise<unknown>,
          config?: { isolationLevel?: string; accessMode?: string },
        ) => {
          const snapshot = { invoice: { ...committed.invoice }, payments: [...committed.payments] };
          void config;
          return run({ select: vi.fn(() => makeSelect(snapshot, true)) });
        },
      ),
    }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    const detail = await service.get(invoiceId);

    expect(paymentCommittedDuringRead).toBe(true);
    expect(detail).toMatchObject({
      status: "issued",
      payments: [],
      paymentSummary: {
        confirmedAmount: "0.00",
        remainingAmount: "48000.00",
        status: "issued",
      },
    });
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
  });

  it("does not let cancellation overwrite a payment that commits before the resource lock", async () => {
    const invoiceId = "31111111-1111-4111-8111-111111111111";
    const tenantId = "21111111-1111-4111-8111-111111111111";
    let status: "issued" | "partially_paid" | "cancelled" = "issued";
    let paymentCommitted = false;
    let invoiceLocked = false;
    let paymentWaiting = false;

    const makeSelect = (insideTransaction: boolean) => {
      let table: unknown;
      let lockedForUpdate = false;
      const query = {
        from: vi.fn((value: unknown) => {
          table = value;
          return query;
        }),
        where: vi.fn(() => query),
        for: vi.fn((mode: string) => {
          if (mode === "update") {
            lockedForUpdate = true;
            invoiceLocked = true;
          }
          return query;
        }),
        limit: vi.fn(async () => {
          if (table !== schema.invoices) return [];
          const observed = status;
          if (insideTransaction && lockedForUpdate) {
            paymentWaiting = true;
          } else {
            status = "partially_paid";
            paymentCommitted = true;
          }
          return [{ id: invoiceId, tenantId, status: observed }];
        }),
      };
      return query;
    };
    const makeUpdate = () => ({
      set: vi.fn((values: { status: "cancelled" }) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => {
            status = values.status;
            return [{ id: invoiceId, tenantId, status }];
          }),
        })),
      })),
    });
    const db = Object.assign(Object.create(null), {
      select: vi.fn(() => makeSelect(false)),
      update: vi.fn(() => makeUpdate()),
      transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
        try {
          return await run({
            execute: vi.fn(async () => ({ rows: [] })),
            select: vi.fn(() => makeSelect(true)),
            update: vi.fn(() => makeUpdate()),
          });
        } finally {
          invoiceLocked = false;
          if (paymentWaiting && status === "issued") {
            status = "partially_paid";
            paymentCommitted = true;
          }
        }
      }),
    }) as Db;
    const service = new BillingService(
      db,
      {} as PlatformAuditService,
      noopTenantBillingNotifications(),
    );

    await expect(service.cancel({} as PlatformPrincipal, invoiceId)).rejects.toMatchObject({
      response: { code: "invoice_paid" },
      status: 409,
    });
    expect(invoiceLocked).toBe(false);
    expect(status).toBe("partially_paid");
    expect(paymentCommitted).toBe(true);
  });
});
