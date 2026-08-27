import type { Db } from "@markiro/db";
import { schema } from "@markiro/db";
import { describe, expect, it, vi } from "vitest";

import type { BillingApplicationService } from "../src/modules/billing/billing-application.service";
import { BillingPaymentsService } from "../src/modules/billing-payments/billing-payments.service";
import type { PlatformPrincipal } from "../src/platform-auth/platform-access-policy";
import type { PlatformAuditService } from "../src/platform-auth/platform-audit.service";

const actor: PlatformPrincipal = {
  userId: "11111111-1111-4111-8111-111111111111",
  role: "accountant",
  capabilities: ["billing.write"],
  twoFactorReady: true,
};
const tenantId = "21111111-1111-4111-8111-111111111111";
const invoiceId = "31111111-1111-4111-8111-111111111111";

function testDouble<T>() {
  return <K extends keyof T>(value: Pick<T, K>): T => value as T;
}

function makeHarness({
  invoiceStatus = "issued",
  existingPayments = [],
  idempotentPayment,
}: {
  invoiceStatus?: "issued" | "partially_paid" | "paid";
  existingPayments?: Array<ReturnType<typeof paymentRow>>;
  idempotentPayment?: ReturnType<typeof paymentRow>;
} = {}) {
  const invoice = {
    id: invoiceId,
    tenantId,
    number: "INV-000001",
    status: invoiceStatus,
    total: "48000.00",
    applicationMode: "automatic",
    paidAt: invoiceStatus === "paid" ? new Date("2026-08-27T10:00:00.000Z") : null,
  };
  const line = {
    id: "41111111-1111-4111-8111-111111111111",
    tenantId,
    invoiceId,
    kind: "plan",
  };
  const insertedPayments: Array<Record<string, unknown>> = [];
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  let paymentSelect = 0;

  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      let table: unknown;
      const query = {
        from: vi.fn((value: unknown) => {
          table = value;
          return query;
        }),
        where: vi.fn(() => query),
        orderBy: vi.fn(() => query),
        limit: vi.fn(async () => {
          if (table === schema.billingPayments) {
            paymentSelect += 1;
            return paymentSelect === 1
              ? idempotentPayment
                ? [idempotentPayment]
                : []
              : existingPayments;
          }
          if (table === schema.invoices) return [invoice];
          if (table === schema.invoiceLines) return [line];
          return [];
        }),
        then: (resolve: (rows: unknown[]) => unknown, reject?: (reason: unknown) => unknown) => {
          const rows =
            table === schema.billingPayments
              ? existingPayments
              : table === schema.invoices
                ? [invoice]
                : table === schema.invoiceLines
                  ? [line]
                  : [];
          return Promise.resolve(rows).then(resolve, reject);
        },
      };
      return query;
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (table === schema.billingPayments && !Array.isArray(values)) {
          insertedPayments.push(values);
        }
        const created =
          table === schema.billingPayments && !Array.isArray(values)
            ? paymentRow({
                id: "51111111-1111-4111-8111-111111111111",
                amount: String(values.amount),
                paidAt: values.paidAt as Date,
                bankReference: String(values.bankReference),
                idempotencyKey: String(values.idempotencyKey),
              })
            : undefined;
        const promise = Promise.resolve(created ? [created] : []);
        return {
          returning: vi.fn(async () => (created ? [created] : [])),
          then: promise.then.bind(promise),
        };
      }),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => {
        if (table === schema.invoices) invoiceUpdates.push(values);
        const promise = Promise.resolve([]);
        return {
          where: vi.fn(() => ({ then: promise.then.bind(promise) })),
        };
      }),
    })),
  };
  const db = Object.assign(Object.create(null), {
    transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
  }) as Db;
  const application = testDouble<BillingApplicationService>()({
    applyAutomaticInTransaction: vi.fn(async () => ({
      invoiceId,
      status: "applied" as const,
      results: [],
    })),
  });
  const audit = testDouble<PlatformAuditService>()({ record: vi.fn(async () => undefined) });
  const service = new BillingPaymentsService(db, application, audit);

  return { application, insertedPayments, invoiceUpdates, service };
}

function paymentRow(
  overrides: Partial<{
    id: string;
    amount: string;
    paidAt: Date;
    bankReference: string;
    idempotencyKey: string;
  }> = {},
) {
  return {
    id: overrides.id ?? "61111111-1111-4111-8111-111111111111",
    tenantId,
    invoiceId,
    source: "manual" as const,
    paidAt: overrides.paidAt ?? new Date("2026-08-27T09:00:00.000Z"),
    amount: overrides.amount ?? "20000.00",
    currency: "RUB",
    bankReference: overrides.bankReference ?? "BANK-1",
    importRowId: null,
    platformUserId: actor.userId,
    idempotencyKey: overrides.idempotencyKey ?? "payment-pay-1",
    createdAt: new Date("2026-08-27T09:00:00.000Z"),
  };
}

describe("BillingPaymentsService confirmed payment reconciliation", () => {
  it("records a partial payment without applying entitlements", async () => {
    const harness = makeHarness();

    const result = await harness.service.recordManual(actor, invoiceId, {
      amount: "20000.00",
      paidAt: new Date("2026-08-27T09:00:00.000Z"),
      bankReference: "BANK-1",
      idempotencyKey: "payment-pay-1",
    });

    expect(result).toMatchObject({
      invoiceStatus: "partially_paid",
      confirmedAmount: "20000.00",
      remainingAmount: "28000.00",
    });
    expect(harness.invoiceUpdates).toEqual([{ status: "partially_paid", paidAt: null }]);
    expect(harness.application.applyAutomaticInTransaction).not.toHaveBeenCalled();
  });

  it("reconciles an imported final payment with an existing confirmed partial payment", async () => {
    const matchId = "71111111-1111-4111-8111-111111111111";
    const importRowId = "81111111-1111-4111-8111-111111111111";
    const match = {
      id: matchId,
      importRowId,
      tenantId,
      invoiceId,
      tenantBankAccountId: null,
      payerAccountEvidence: { kind: "unknown", last4: "0001" },
      status: "suggested" as const,
      score: 80,
      reason: "invoice_number",
      decidedByPlatformUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-08-27T09:30:00.000Z"),
    };
    const row = {
      id: importRowId,
      importId: "91111111-1111-4111-8111-111111111111",
      sourceRowId: "1",
      operationDate: new Date("2026-08-27T10:00:00.000Z"),
      amount: "28000.00",
      currency: "RUB",
      payerName: "Factory",
      paymentPurpose: "INV-000001",
      bankReference: "BANK-2",
      rawFields: { reference: "BANK-2" },
      parseError: null,
      createdAt: new Date("2026-08-27T09:30:00.000Z"),
    };
    const invoice = {
      id: invoiceId,
      tenantId,
      number: "INV-000001",
      status: "partially_paid" as const,
      total: "48000.00",
      applicationMode: "automatic" as const,
      paidAt: null,
    };
    const partial = paymentRow();
    const invoiceUpdates: Array<Record<string, unknown>> = [];
    let paymentSelect = 0;
    const tx = {
      select: vi.fn(() => {
        let table: unknown;
        const query = {
          from: vi.fn((value: unknown) => {
            table = value;
            return query;
          }),
          where: vi.fn(() => query),
          for: vi.fn(() => query),
          limit: vi.fn(async () => {
            if (table === schema.paymentMatches) return [match];
            if (table === schema.paymentImportRows) return [row];
            if (table === schema.invoices) return [invoice];
            if (table === schema.billingPayments) {
              paymentSelect += 1;
              return paymentSelect === 1 ? [] : [partial];
            }
            return [];
          }),
          then: (resolve: (rows: unknown[]) => unknown) => {
            const rows =
              table === schema.billingPayments
                ? [partial]
                : table === schema.invoiceLines
                  ? [
                      {
                        id: "41111111-1111-4111-8111-111111111111",
                        tenantId,
                        invoiceId,
                        kind: "plan",
                      },
                    ]
                  : [];
            return Promise.resolve(rows).then(resolve);
          },
        };
        return query;
      }),
      insert: vi.fn((table: unknown) => ({
        values: vi.fn((values: Record<string, unknown> | Array<Record<string, unknown>>) => {
          const created =
            table === schema.billingPayments && !Array.isArray(values)
              ? {
                  ...paymentRow({ amount: row.amount, paidAt: row.operationDate }),
                  source: "bank_import" as const,
                  importRowId,
                  idempotencyKey: `bank-import:${importRowId}`,
                }
              : undefined;
          const promise = Promise.resolve(created ? [created] : []);
          return {
            returning: vi.fn(async () => (created ? [created] : [])),
            then: promise.then.bind(promise),
          };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          if (table === schema.invoices) invoiceUpdates.push(values);
          const updated = table === schema.paymentMatches ? [{ ...match, ...values }] : [];
          return {
            where: vi.fn(() => ({
              returning: vi.fn(async () => updated),
              then: Promise.resolve(updated).then.bind(Promise.resolve(updated)),
            })),
          };
        }),
      })),
    };
    const db = Object.assign(Object.create(null), {
      transaction: vi.fn(async (run: (executor: typeof tx) => Promise<unknown>) => run(tx)),
    }) as Db;
    const application = testDouble<BillingApplicationService>()({
      applyAutomaticInTransaction: vi.fn(async () => ({
        invoiceId,
        status: "applied" as const,
        results: [],
      })),
    });
    const audit = testDouble<PlatformAuditService>()({ record: vi.fn(async () => undefined) });
    const service = new BillingPaymentsService(db, application, audit);

    await expect(
      service.resolveMatch(actor, matchId, {
        decision: "matched",
        tenantId,
        invoiceId,
        tenantBankAccountId: null,
        reason: "operator_confirmed",
      }),
    ).resolves.toMatchObject({ status: "matched", invoiceId });
    expect(invoiceUpdates).toEqual([{ status: "paid", paidAt: row.operationDate }]);
    expect(application.applyAutomaticInTransaction).toHaveBeenCalledTimes(1);
  });

  it("records the exact remaining amount and applies automatic lines once", async () => {
    const harness = makeHarness({
      invoiceStatus: "partially_paid",
      existingPayments: [paymentRow()],
    });

    const result = await harness.service.recordManual(actor, invoiceId, {
      amount: "28000.00",
      paidAt: new Date("2026-08-27T10:00:00.000Z"),
      bankReference: "BANK-2",
      idempotencyKey: "payment-pay-2",
    });

    expect(result).toMatchObject({
      invoiceStatus: "paid",
      confirmedAmount: "48000.00",
      remainingAmount: "0.00",
    });
    expect(harness.application.applyAutomaticInTransaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an amount greater than the locked remaining balance", async () => {
    const harness = makeHarness({
      invoiceStatus: "partially_paid",
      existingPayments: [paymentRow()],
    });

    await expect(
      harness.service.recordManual(actor, invoiceId, {
        amount: "28000.01",
        paidAt: new Date("2026-08-27T10:00:00.000Z"),
        bankReference: "BANK-OVER",
        idempotencyKey: "payment-over",
      }),
    ).rejects.toMatchObject({ response: { code: "payment_amount_exceeds_remaining" } });
    expect(harness.insertedPayments).toHaveLength(0);
  });

  it("returns the original reconciliation for an exact idempotent replay", async () => {
    const original = paymentRow();
    const harness = makeHarness({
      invoiceStatus: "partially_paid",
      existingPayments: [original],
      idempotentPayment: original,
    });

    const result = await harness.service.recordManual(actor, invoiceId, {
      amount: original.amount,
      paidAt: original.paidAt,
      bankReference: original.bankReference,
      idempotencyKey: original.idempotencyKey,
    });

    expect(result).toMatchObject({
      id: original.id,
      invoiceStatus: "partially_paid",
      confirmedAmount: "20000.00",
      remainingAmount: "28000.00",
    });
    expect(harness.insertedPayments).toHaveLength(0);
    expect(harness.application.applyAutomaticInTransaction).not.toHaveBeenCalled();
  });
});
