import { randomUUID } from "node:crypto";
import { createDb, schema } from "@markiro/db";
import type { PlatformReportInput } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMERCIAL_COLUMNS } from "../src/platform-reports/commercial-report-source";
import { PlatformReportSourceService } from "../src/platform-reports/report-source.service";
import {
  cleanupEvidence,
  seedEvidenceBase,
  type EvidenceBase,
} from "./support/platform-report-evidence-base";
import { createOrganization, createPublishedPlan } from "./support/subscription-fixtures";

const url = process.env.DATABASE_URL;
const local = url ? ["localhost", "127.0.0.1"].includes(new URL(url).hostname) : false;

// The report window 2026-09-01..2026-09-02 in Europe/Moscow is [2026-08-31T21:00Z, 2026-09-02T21:00Z).
// One second before it opens, local 2026-08-31 23:59:59.
const JUST_BEFORE = new Date("2026-08-31T20:59:59Z");
// Its exclusive end, local 2026-09-03 00:00:00.
const AT_END = new Date("2026-09-02T21:00:00Z");

describe.skipIf(!local)("commercial report projection on real Postgres", () => {
  const { db, pool } = createDb(url ?? "postgres://localhost:55439/unavailable");
  const service = new PlatformReportSourceService(db);
  const actor = randomUUID();
  let base: EvidenceBase;
  let tenantC: string;
  let tenantD: string;
  // Sorts after base.tenant and base.other, so multi-tenant row order does not depend on uuids.
  const tenantE = `evidence-e-${randomUUID()}`;
  let planVersionId: string;
  let input: PlatformReportInput;

  async function paidOfferSubscription(
    tenantId: string,
    values: {
      status: "active" | "pending_activation" | "expired" | "cancelled";
      startsAt: Date | null;
      createdAt: Date;
    },
  ) {
    const offerId = randomUUID();
    const offerLineId = randomUUID();
    await db
      .insert(schema.commercialOffers)
      .values({ id: offerId, tenantId, revision: 1, status: "draft", total: "120.00" });
    await db.insert(schema.commercialOfferLines).values({
      id: offerLineId,
      tenantId,
      offerId,
      position: 1,
      kind: "plan",
      catalogVersionId: planVersionId,
      nameRu: "Evidence plan",
      nameEn: "Evidence plan",
      quantity: 1,
      unit: "месяц",
      agreedUnitPrice: "100.00",
      vatRate: "20.00",
      vatIncluded: false,
      lineTotal: "100.00",
      activationPolicy: "immediately",
    });
    await db.insert(schema.tenantSubscriptions).values({
      tenantId,
      planVersionId,
      status: values.status,
      source: "paid_offer_line",
      sourceOfferLineId: offerLineId,
      startsAt: values.startsAt,
      endsAt: null,
      createdAt: values.createdAt,
    });
    return offerId;
  }

  // The legacy offer-payment flow: one payment per offer.
  async function legacyPayment(tenantId: string, paidAt: Date, amount: string) {
    const offerId = randomUUID();
    await db
      .insert(schema.commercialOffers)
      .values({ id: offerId, tenantId, revision: 1, status: "draft", total: amount });
    await db.insert(schema.payments).values({
      tenantId,
      offerId,
      paidAt,
      amount,
      bankReference: `EV-${randomUUID()}`,
      platformUserId: actor,
      idempotencyKey: `ev-${randomUUID()}`,
    });
  }

  beforeAll(async () => {
    base = await seedEvidenceBase(db);
    tenantC = await createOrganization(db);
    tenantD = await createOrganization(db);
    await createOrganization(db, tenantE);
    planVersionId = await createPublishedPlan(db, {
      maxLines: 1,
      maxStations: 1,
      maxKiosks: 1,
      maxCabinetUsers: 1,
    });
    input = {
      reportType: "commercial",
      tenantIds: [base.tenant],
      fromDate: "2026-09-01",
      toDate: "2026-09-02",
      timezone: "Europe/Moscow",
      periodBasis: "events",
      privacy: "identified",
    };
    await db.insert(schema.platformUsers).values({
      id: actor,
      name: "Evidence actor",
      email: `${actor}@example.invalid`,
      role: "platform_admin",
      status: "active",
    });
    const invoice = (
      values: Partial<typeof schema.invoices.$inferInsert> & {
        subtotal: string;
        vatTotal: string;
        total: string;
      },
    ): typeof schema.invoices.$inferInsert => ({
      tenantId: base.tenant,
      number: `EV-${randomUUID()}`,
      status: "issued",
      issueDate: new Date("2026-09-01T00:00:00Z"),
      sellerSnapshot: {},
      buyerSnapshot: {},
      createdByPlatformUserId: actor,
      ...values,
    });
    const invoiceIds = { issued: randomUUID(), paid: randomUUID(), cancelled: randomUUID() };
    const foreignInvoiceId = randomUUID();
    await db.insert(schema.invoices).values([
      invoice({
        id: invoiceIds.issued,
        subtotal: "1000.00",
        vatTotal: "200.00",
        total: "1200.00",
        issuedAt: new Date("2026-09-01T09:00:00Z"),
      }),
      invoice({
        id: invoiceIds.paid,
        status: "paid",
        subtotal: "500.00",
        vatTotal: "100.00",
        total: "600.00",
        issuedAt: new Date("2026-09-01T10:00:00Z"),
        paidAt: new Date("2026-09-02T11:00:00Z"),
      }),
      // Issued on local 2026-08-31 23:00, cancelled on 2026-09-01: counts only as cancelled.
      invoice({
        id: invoiceIds.cancelled,
        status: "cancelled",
        subtotal: "300.50",
        vatTotal: "60.10",
        total: "360.60",
        issuedAt: new Date("2026-08-31T20:00:00Z"),
        cancelledAt: new Date("2026-09-01T12:00:00Z"),
      }),
      // A draft is never issued.
      invoice({
        status: "draft",
        issueDate: null,
        sellerSnapshot: null,
        buyerSnapshot: null,
        subtotal: "0",
        vatTotal: "0",
        total: "0",
      }),
      // Foreign tenant, issued in the window.
      invoice({
        id: foreignInvoiceId,
        tenantId: base.other,
        subtotal: "77.00",
        vatTotal: "0.00",
        total: "77.00",
        issuedAt: new Date("2026-09-01T09:00:00Z"),
      }),
    ]);
    await db.insert(schema.billingPayments).values([
      {
        tenantId: base.tenant,
        invoiceId: invoiceIds.issued,
        source: "manual",
        paidAt: new Date("2026-09-01T13:00:00Z"),
        amount: "400.00",
        bankReference: `EV-${randomUUID()}`,
        platformUserId: actor,
        idempotencyKey: `ev-${randomUUID()}`,
      },
      {
        tenantId: base.tenant,
        invoiceId: invoiceIds.paid,
        source: "manual",
        paidAt: new Date("2026-09-02T11:00:00Z"),
        amount: "600.00",
        bankReference: `EV-${randomUUID()}`,
        platformUserId: actor,
        idempotencyKey: `ev-${randomUUID()}`,
      },
    ]);
    // Legacy offer payment: a separate flow from invoice payments, summed with them.
    const legacyOfferId = randomUUID();
    await db.insert(schema.commercialOffers).values({
      id: legacyOfferId,
      tenantId: base.tenant,
      revision: 1,
      status: "draft",
      total: "250.00",
    });
    await db.insert(schema.payments).values({
      tenantId: base.tenant,
      offerId: legacyOfferId,
      paidAt: new Date("2026-09-01T14:00:00Z"),
      amount: "250.00",
      bankReference: `EV-${randomUUID()}`,
      platformUserId: actor,
      idempotencyKey: `ev-${randomUUID()}`,
    });
    await db.insert(schema.billingActs).values([
      {
        tenantId: base.tenant,
        number: `EV-ACT-${randomUUID()}`,
        status: "issued",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actor,
        issuedByPlatformUserId: actor,
        issuedAt: new Date("2026-09-01T15:00:00Z"),
      },
      {
        tenantId: base.tenant,
        number: `EV-ACT-${randomUUID()}`,
        status: "draft",
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actor,
      },
    ]);
    await paidOfferSubscription(base.tenant, {
      status: "active",
      startsAt: new Date("2026-09-01T06:00:00Z"),
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });
    const agreement = (
      values: Partial<typeof schema.platformAgreements.$inferInsert>,
    ): typeof schema.platformAgreements.$inferInsert => ({
      number: `EV-AGR-${randomUUID()}`,
      counterparty: {},
      contractor: {},
      terms: {},
      createdByPlatformUserId: actor,
      ...values,
    });
    await db.insert(schema.platformAgreements).values([
      agreement({
        status: "signed",
        tenantId: base.tenant,
        signedAt: new Date("2026-09-01T16:00:00Z"),
        signedSnapshot: {},
      }),
      // Signed but not linked to a tenant: never reported.
      agreement({
        status: "signed",
        signedAt: new Date("2026-09-01T16:30:00Z"),
        signedSnapshot: {},
      }),
      agreement({ status: "draft", tenantId: base.tenant }),
    ]);
    // Tenant C: a paid subscription with no start date falls back to its creation time.
    await paidOfferSubscription(tenantC, {
      status: "pending_activation",
      startsAt: null,
      createdAt: new Date("2026-09-02T06:00:00Z"),
    });
    // Tenant D: a manual subscription is not a paid one.
    await db.insert(schema.tenantSubscriptions).values({
      tenantId: tenantD,
      planVersionId,
      status: "active",
      source: "manual",
      startsAt: new Date("2026-09-01T06:00:00Z"),
      endsAt: new Date("2026-10-01T06:00:00Z"),
    });

    // Window controls. Every fact family of tenant A gets one fact one second before the window and
    // one at its exclusive end. None of them may change the two rows of the window itself.
    await db.insert(schema.invoices).values([
      // issued_at controls; one is enough per boundary, amounts differ so a leak is visible.
      invoice({
        subtotal: "13.13",
        vatTotal: "2.63",
        total: "15.76",
        issuedAt: JUST_BEFORE,
      }),
      invoice({
        subtotal: "17.17",
        vatTotal: "3.43",
        total: "20.60",
        issuedAt: AT_END,
      }),
      // cancelled_at controls, issued long before the window.
      invoice({
        status: "cancelled",
        subtotal: "19.19",
        vatTotal: "3.84",
        total: "23.03",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        cancelledAt: JUST_BEFORE,
      }),
      invoice({
        status: "cancelled",
        subtotal: "19.19",
        vatTotal: "3.84",
        total: "23.03",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        cancelledAt: AT_END,
      }),
      // paid_at controls, issued long before the window.
      invoice({
        status: "paid",
        subtotal: "21.21",
        vatTotal: "4.24",
        total: "25.45",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        paidAt: JUST_BEFORE,
      }),
      invoice({
        status: "paid",
        subtotal: "21.21",
        vatTotal: "4.24",
        total: "25.45",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        paidAt: AT_END,
      }),
    ]);
    // billing_payments controls on an invoice issued long before the window. The amounts stay below
    // its total, so the completion trigger never fires.
    const controlPayInvoiceId = randomUUID();
    await db.insert(schema.invoices).values(
      invoice({
        id: controlPayInvoiceId,
        subtotal: "1000.00",
        vatTotal: "200.00",
        total: "1200.00",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    );
    await db.insert(schema.billingPayments).values(
      (
        [
          [JUST_BEFORE, "11.11"],
          [AT_END, "22.22"],
        ] as const
      ).map(([paidAt, amount]) => ({
        tenantId: base.tenant,
        invoiceId: controlPayInvoiceId,
        source: "manual" as const,
        paidAt,
        amount,
        bankReference: `EV-${randomUUID()}`,
        platformUserId: actor,
        idempotencyKey: `ev-${randomUUID()}`,
      })),
    );
    // Legacy payment controls.
    await legacyPayment(base.tenant, JUST_BEFORE, "33.33");
    await legacyPayment(base.tenant, AT_END, "44.44");
    // Act controls.
    await db.insert(schema.billingActs).values(
      [JUST_BEFORE, AT_END].map((issuedAt) => ({
        tenantId: base.tenant,
        number: `EV-ACT-${randomUUID()}`,
        status: "issued" as const,
        periodStart: "2026-08-01",
        periodEnd: "2026-08-31",
        createdByPlatformUserId: actor,
        issuedByPlatformUserId: actor,
        issuedAt,
      })),
    );
    // Paid subscription controls, none of them current (one current subscription per tenant):
    // dated by starts_at, and by created_at where starts_at is null.
    const longBefore = new Date("2026-08-01T00:00:00Z");
    await paidOfferSubscription(base.tenant, {
      status: "expired",
      startsAt: JUST_BEFORE,
      createdAt: longBefore,
    });
    await paidOfferSubscription(base.tenant, {
      status: "expired",
      startsAt: AT_END,
      createdAt: longBefore,
    });
    await paidOfferSubscription(base.tenant, {
      status: "cancelled",
      startsAt: null,
      createdAt: JUST_BEFORE,
    });
    await paidOfferSubscription(base.tenant, {
      status: "cancelled",
      startsAt: null,
      createdAt: AT_END,
    });
    // Agreement controls.
    await db
      .insert(schema.platformAgreements)
      .values(
        [JUST_BEFORE, AT_END].map((signedAt) =>
          agreement({ status: "signed", tenantId: base.tenant, signedAt, signedSnapshot: {} }),
        ),
      );

    // Foreign tenant B, same window, several families: a payment on its issued invoice, a legacy
    // payment, a cancelled and a paid invoice, an issued act and a paid subscription.
    await db.insert(schema.billingPayments).values({
      tenantId: base.other,
      invoiceId: foreignInvoiceId,
      source: "manual",
      paidAt: new Date("2026-09-01T10:00:00Z"),
      amount: "30.00",
      bankReference: `EV-${randomUUID()}`,
      platformUserId: actor,
      idempotencyKey: `ev-${randomUUID()}`,
    });
    await legacyPayment(base.other, new Date("2026-09-01T12:00:00Z"), "5.50");
    await db.insert(schema.invoices).values([
      invoice({
        tenantId: base.other,
        status: "cancelled",
        subtotal: "5.00",
        vatTotal: "0.00",
        total: "5.00",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        cancelledAt: new Date("2026-09-01T12:30:00Z"),
      }),
      invoice({
        tenantId: base.other,
        status: "paid",
        subtotal: "6.00",
        vatTotal: "0.00",
        total: "6.00",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
        paidAt: new Date("2026-09-01T13:30:00Z"),
      }),
    ]);
    await db.insert(schema.billingActs).values({
      tenantId: base.other,
      number: `EV-ACT-${randomUUID()}`,
      status: "issued",
      periodStart: "2026-08-01",
      periodEnd: "2026-08-31",
      createdByPlatformUserId: actor,
      issuedByPlatformUserId: actor,
      issuedAt: new Date("2026-09-01T11:00:00Z"),
    });
    await paidOfferSubscription(base.other, {
      status: "active",
      startsAt: new Date("2026-09-01T06:00:00Z"),
      createdAt: new Date("2026-08-01T00:00:00Z"),
    });

    // Tenant E: an agreement signed in the window, and a subscription that comes from an invoice
    // line rather than an offer line. base.other keeps agreements_signed at 0 (asserted below),
    // so the foreign agreement lives here.
    await db.insert(schema.platformAgreements).values(
      agreement({
        status: "signed",
        tenantId: tenantE,
        signedAt: new Date("2026-09-01T16:00:00Z"),
        signedSnapshot: {},
      }),
    );
    const invoiceLineInvoiceId = randomUUID();
    await db.insert(schema.invoices).values(
      invoice({
        id: invoiceLineInvoiceId,
        tenantId: tenantE,
        subtotal: "100.00",
        vatTotal: "20.00",
        total: "120.00",
        issuedAt: new Date("2026-08-01T00:00:00Z"),
      }),
    );
    const invoiceLineId = randomUUID();
    await db.insert(schema.invoiceLines).values({
      id: invoiceLineId,
      tenantId: tenantE,
      invoiceId: invoiceLineInvoiceId,
      position: 1,
      kind: "plan",
      catalogVersionId: planVersionId,
      catalogKind: "plan",
      nameRu: "Evidence plan",
      nameEn: "Evidence plan",
      quantity: 1,
      unit: "месяц",
      agreedUnitPrice: "100.00",
      vatRate: "20.00",
      vatIncluded: false,
      lineSubtotal: "100.00",
      lineVat: "20.00",
      lineTotal: "120.00",
      activationPolicy: "immediate",
    });
    await db.insert(schema.tenantSubscriptions).values({
      tenantId: tenantE,
      planVersionId,
      status: "active",
      source: "paid_invoice_line",
      sourceInvoiceLineId: invoiceLineId,
      startsAt: new Date("2026-09-01T07:00:00Z"),
      endsAt: null,
    });
  });

  afterAll(async () => {
    const tenants = [base.tenant, base.other, tenantC, tenantD, tenantE];
    const tenantList = sql.join(
      tenants.map((tenant) => sql`${tenant}`),
      sql`, `,
    );
    // `payments` rejects DELETE and a draft `commercial_offers` row silently survives one (append-only
    // and published-offer triggers), so the shared cleanup cannot remove the offer fixtures. This
    // disposable database runs as a superuser: delete them with triggers off, inside one transaction
    // and scoped to this test's tenants, children before parents.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role = replica`);
      await tx.execute(sql`DELETE FROM payments WHERE tenant_id IN (${tenantList})`);
      await tx.execute(sql`DELETE FROM tenant_subscriptions WHERE tenant_id IN (${tenantList})`);
      await tx.execute(sql`DELETE FROM commercial_offer_lines WHERE tenant_id IN (${tenantList})`);
      await tx.execute(sql`DELETE FROM commercial_offers WHERE tenant_id IN (${tenantList})`);
    });
    // Invoice lines are not in the shared cleanup list and the invoice that owns one cannot go first.
    await db.execute(sql`DELETE FROM invoice_lines WHERE tenant_id = ${tenantE}`);
    await cleanupEvidence(db, tenants, {
      users: [base.user],
      platformUsers: [actor],
    });
    await pool.end();
  });

  const tenantARows = () => [
    {
      tenant_id: base.tenant,
      tenant_name: "Evidence fixture A",
      day: "2026-09-01",
      invoices_issued: 2,
      invoices_issued_net_minor: 150000,
      invoices_issued_vat_minor: 30000,
      invoices_issued_total_minor: 180000,
      invoices_cancelled: 1,
      invoices_paid: 0,
      payments_received: 2,
      payments_received_minor: 65000,
      acts_issued: 1,
      paid_subscriptions_started: 1,
      agreements_signed: 1,
    },
    {
      tenant_id: base.tenant,
      tenant_name: "Evidence fixture A",
      day: "2026-09-02",
      invoices_issued: 0,
      invoices_issued_net_minor: 0,
      invoices_issued_vat_minor: 0,
      invoices_issued_total_minor: 0,
      invoices_cancelled: 0,
      invoices_paid: 1,
      payments_received: 1,
      payments_received_minor: 60000,
      acts_issued: 0,
      paid_subscriptions_started: 0,
      agreements_signed: 0,
    },
  ];
  // Hand-calculated from the foreign fixtures: invoice 77.00 issued; payments 30.00 + 5.50 in
  // kopecks 3000 + 550; one cancelled and one paid invoice; one act; one paid subscription.
  const tenantBRow = () => ({
    tenant_id: base.other,
    tenant_name: "Evidence fixture B",
    day: "2026-09-01",
    invoices_issued: 1,
    invoices_issued_net_minor: 7700,
    invoices_issued_vat_minor: 0,
    invoices_issued_total_minor: 7700,
    invoices_cancelled: 1,
    invoices_paid: 1,
    payments_received: 2,
    payments_received_minor: 3550,
    acts_issued: 1,
    paid_subscriptions_started: 1,
    agreements_signed: 0,
  });
  const tenantERow = () => ({
    tenant_id: tenantE,
    tenant_name: `Subscription fixture ${tenantE}`,
    day: "2026-09-01",
    invoices_issued: 0,
    invoices_issued_net_minor: 0,
    invoices_issued_vat_minor: 0,
    invoices_issued_total_minor: 0,
    invoices_cancelled: 0,
    invoices_paid: 0,
    payments_received: 0,
    payments_received_minor: 0,
    acts_issued: 0,
    paid_subscriptions_started: 1,
    agreements_signed: 1,
  });

  it("counts invoices, payments from both flows, acts, paid subscriptions and agreements in kopecks", async () => {
    const result = await service.load(input);
    expect(result.columns).toEqual([...COMMERCIAL_COLUMNS]);
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-01",
        invoices_issued: 2,
        invoices_issued_net_minor: 150000,
        invoices_issued_vat_minor: 30000,
        invoices_issued_total_minor: 180000,
        invoices_cancelled: 1,
        invoices_paid: 0,
        payments_received: 2,
        payments_received_minor: 65000,
        acts_issued: 1,
        paid_subscriptions_started: 1,
        agreements_signed: 1,
      },
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-02",
        invoices_issued: 0,
        invoices_issued_net_minor: 0,
        invoices_issued_vat_minor: 0,
        invoices_issued_total_minor: 0,
        invoices_cancelled: 0,
        invoices_paid: 1,
        payments_received: 1,
        payments_received_minor: 60000,
        acts_issued: 0,
        paid_subscriptions_started: 0,
        agreements_signed: 0,
      },
    ]);
  });

  it("excludes the foreign tenant, drafts and unlinked agreements", async () => {
    const both = await service.load({ ...input, tenantIds: [base.tenant, base.other] });
    expect(both.rows.filter((row) => row.tenant_id === base.other)).toEqual([
      expect.objectContaining({
        tenant_name: "Evidence fixture B",
        invoices_issued: 1,
        invoices_issued_total_minor: 7700,
        agreements_signed: 0,
      }),
    ]);
    const only = await service.load(input);
    expect(only.rows.every((row) => row.tenant_id === base.tenant)).toBe(true);
  });

  it("dates a paid subscription without a start date by its creation time and ignores manual ones", async () => {
    const result = await service.load({ ...input, tenantIds: [tenantC, tenantD] });
    expect(result.rows).toEqual([
      expect.objectContaining({
        tenant_id: tenantC,
        day: "2026-09-02",
        paid_subscriptions_started: 1,
      }),
    ]);
  });

  it("does not expose financial documents or bank details", async () => {
    const text = JSON.stringify(await service.load(input));
    expect(text).not.toContain("EV-");
  });

  it("reports the facts one second before the window on the previous local day", async () => {
    // The same facts that the window test above must not count. Invoice (issued 2026-08-31 23:00
    // local, cancelled later) and control: net 300.50 + 13.13, vat 60.10 + 2.63, total 360.60 + 15.76.
    const result = await service.load({ ...input, fromDate: "2026-08-31", toDate: "2026-08-31" });
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-08-31",
        invoices_issued: 2,
        invoices_issued_net_minor: 31363,
        invoices_issued_vat_minor: 6273,
        invoices_issued_total_minor: 37636,
        invoices_cancelled: 1,
        invoices_paid: 1,
        // Invoice payment 11.11 and legacy payment 33.33.
        payments_received: 2,
        payments_received_minor: 4444,
        acts_issued: 1,
        // One dated by starts_at, one by created_at.
        paid_subscriptions_started: 2,
        agreements_signed: 1,
      },
    ]);
  });

  it("reports the facts at the exclusive end of the window on the next local day", async () => {
    const result = await service.load({ ...input, fromDate: "2026-09-03", toDate: "2026-09-03" });
    expect(result.rows).toEqual([
      {
        tenant_id: base.tenant,
        tenant_name: "Evidence fixture A",
        day: "2026-09-03",
        invoices_issued: 1,
        invoices_issued_net_minor: 1717,
        invoices_issued_vat_minor: 343,
        invoices_issued_total_minor: 2060,
        invoices_cancelled: 1,
        invoices_paid: 1,
        // Invoice payment 22.22 and legacy payment 44.44.
        payments_received: 2,
        payments_received_minor: 6666,
        acts_issued: 1,
        paid_subscriptions_started: 2,
        agreements_signed: 1,
      },
    ]);
  });

  it("keeps selected tenants apart when several tenants have facts in the same window", async () => {
    expect((await service.load(input)).rows).toEqual(tenantARows());
    expect((await service.load({ ...input, tenantIds: [base.other] })).rows).toEqual([
      tenantBRow(),
    ]);
    expect((await service.load({ ...input, tenantIds: [tenantE] })).rows).toEqual([tenantERow()]);
    expect((await service.load({ ...input, tenantIds: [base.tenant, base.other] })).rows).toEqual([
      ...tenantARows(),
      tenantBRow(),
    ]);
    expect(
      (await service.load({ ...input, tenantIds: [base.tenant, base.other, tenantE] })).rows,
    ).toEqual([...tenantARows(), tenantBRow(), tenantERow()]);
  });
});
