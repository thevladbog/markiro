import { describe, expect, it } from "vitest";

import { platformCommercialContracts } from "../src/index.js";

const TENANT_ID = "legacy_better_auth_org";
const OFFER_ID = "11111111-1111-4111-8111-111111111111";
const OFFER_LINE_ID = "21111111-1111-4111-8111-111111111111";
const INVOICE_ID = "31111111-1111-4111-8111-111111111111";
const INVOICE_LINE_ID = "41111111-1111-4111-8111-111111111111";
const DOCUMENT_ID = "51111111-1111-4111-8111-111111111111";
const PAYMENT_ID = "61111111-1111-4111-8111-111111111111";
const CATALOG_VERSION_ID = "71111111-1111-4111-8111-111111111111";
const PLATFORM_USER_ID = "platform-accountant";
const CREATED_AT = "2026-08-21 10:00:00+00";
const ISO_CREATED_AT = "2026-08-21T10:00:00.000Z";

const offerBase = {
  id: OFFER_ID,
  tenantId: TENANT_ID,
  familyId: "81111111-1111-4111-8111-111111111111",
  revision: 1,
  previousRevisionId: null,
  number: null,
  total: "15000.00",
  expiresAt: null,
  termsMarkdown: null,
  publishedAt: null,
  publishedByPlatformUserId: null,
  paidAt: null,
  createdByPlatformUserId: PLATFORM_USER_ID,
  createdAt: CREATED_AT,
  updatedAt: new Date("2026-08-21T10:00:00.000Z"),
} as const;

const offerLine = {
  id: OFFER_LINE_ID,
  tenantId: TENANT_ID,
  offerId: OFFER_ID,
  position: 1,
  kind: "plan",
  catalogVersionId: CATALOG_VERSION_ID,
  nameRu: "Производство",
  nameEn: "Production",
  descriptionRu: null,
  descriptionEn: null,
  quantity: 1,
  unit: "month",
  catalogUnitPrice: "15000.00",
  agreedUnitPrice: "15000.00",
  vatRate: "20.00",
  vatIncluded: true,
  priceOverrideReason: null,
  activationPolicy: "immediately",
  lineTotal: "15000.00",
  createdAt: CREATED_AT,
} as const;

const invoiceBase = {
  id: INVOICE_ID,
  tenantId: TENANT_ID,
  number: "INV-000021",
  issueDate: null,
  dueDate: null,
  currency: "RUB",
  sellerSnapshot: null,
  buyerSnapshot: null,
  subtotal: "12500.00",
  vatTotal: "2500.00",
  total: "15000.00",
  applicationMode: "automatic",
  createdByPlatformUserId: PLATFORM_USER_ID,
  issuedByPlatformUserId: null,
  issuedAt: null,
  paidAt: null,
  cancelledAt: null,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
} as const;

const invoiceLine = {
  id: INVOICE_LINE_ID,
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  position: 1,
  kind: "plan",
  catalogVersionId: CATALOG_VERSION_ID,
  catalogKind: "plan",
  nameRu: "Производство",
  nameEn: "Production",
  descriptionRu: null,
  descriptionEn: null,
  quantity: 1,
  unit: "month",
  catalogUnitPrice: "15000.00",
  agreedUnitPrice: "15000.00",
  vatRate: "20.00",
  vatIncluded: true,
  lineSubtotal: "12500.00",
  lineVat: "2500.00",
  lineTotal: "15000.00",
  activationPolicy: "manual",
  createdAt: CREATED_AT,
} as const;

const pendingDocument = {
  id: DOCUMENT_ID,
  revision: 1,
  format: "html",
  status: "pending",
  contentType: null,
  byteSize: null,
  sha256: null,
  errorCode: null,
} as const;

const readyDocument = {
  id: "52111111-1111-4111-8111-111111111111",
  revision: 1,
  format: "pdf",
  status: "ready",
  contentType: "application/pdf",
  byteSize: 2048,
  sha256: "a".repeat(64),
  errorCode: null,
} as const;

const failedDocument = {
  id: "53111111-1111-4111-8111-111111111111",
  revision: 2,
  format: "html",
  status: "failed",
  contentType: null,
  byteSize: null,
  sha256: null,
  errorCode: "render_failed",
} as const;

const billingPayment = {
  id: PAYMENT_ID,
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  source: "manual",
  paidAt: "2026-08-21T12:00:00.000Z",
  amount: "15000.00",
  currency: "RUB",
  bankReference: "BANK-42",
  importRowId: null,
  platformUserId: PLATFORM_USER_ID,
  idempotencyKey: "invoice-payment-42",
  createdAt: CREATED_AT,
} as const;

const applicationEvent = {
  id: "91111111-1111-4111-8111-111111111111",
  tenantId: TENANT_ID,
  invoiceId: INVOICE_ID,
  invoiceLineId: INVOICE_LINE_ID,
  attempt: 1,
  status: "skipped",
  kind: "plan",
  source: "manual",
  beforeSnapshot: null,
  afterSnapshot: { id: "a1111111-1111-4111-8111-111111111111" },
  errorCode: null,
  actorPlatformUserId: PLATFORM_USER_ID,
  createdAt: CREATED_AT,
} as const;

describe("platform commercial contracts", () => {
  it("parses every offer success route with exact statuses and offer activation spelling", () => {
    const list = platformCommercialContracts.offers.list.response.parse([
      { ...offerBase, status: "draft" },
      {
        ...offerBase,
        id: "12111111-1111-4111-8111-111111111111",
        status: "published",
        number: "KP-2026-000001",
        publishedAt: CREATED_AT,
        publishedByPlatformUserId: PLATFORM_USER_ID,
      },
      {
        ...offerBase,
        id: "13111111-1111-4111-8111-111111111111",
        status: "paid",
        number: "KP-2026-000002",
        publishedAt: CREATED_AT,
        publishedByPlatformUserId: PLATFORM_USER_ID,
        paidAt: CREATED_AT,
      },
      { ...offerBase, id: "14111111-1111-4111-8111-111111111111", status: "cancelled" },
      { ...offerBase, id: "15111111-1111-4111-8111-111111111111", status: "expired" },
    ]);
    expect(list[0]?.createdAt).toBe(ISO_CREATED_AT);

    const detail = platformCommercialContracts.offers.detail.response.parse({
      ...offerBase,
      status: "draft",
      lines: [
        offerLine,
        {
          ...offerLine,
          id: "22111111-1111-4111-8111-111111111111",
          activationPolicy: "after_current",
        },
      ],
    });
    expect(detail.lines.map((line) => line.activationPolicy)).toEqual([
      "immediately",
      "after_current",
    ]);

    expect(
      platformCommercialContracts.offers.create.response.parse({
        ...offerBase,
        status: "draft",
        lines: [offerLine],
      }).status,
    ).toBe("draft");
    expect(
      platformCommercialContracts.offers.publish.response.parse({
        ...offerBase,
        status: "published",
        number: "KP-2026-000001",
        publishedAt: CREATED_AT,
        publishedByPlatformUserId: PLATFORM_USER_ID,
        lines: [offerLine],
        documents: { revision: 1, documents: [readyDocument, failedDocument] },
      }).status,
    ).toBe("published");
    expect(
      platformCommercialContracts.offers.cancel.response.parse({
        ...offerBase,
        status: "cancelled",
        lines: [offerLine],
      }).status,
    ).toBe("cancelled");
    expect(
      platformCommercialContracts.offers.payment.response.parse({
        paymentId: PAYMENT_ID,
        fulfilments: ["a1111111-1111-4111-8111-111111111111"],
        subscriptionId: "b1111111-1111-4111-8111-111111111111",
      }),
    ).toEqual({
      paymentId: PAYMENT_ID,
      fulfilments: ["a1111111-1111-4111-8111-111111111111"],
      subscriptionId: "b1111111-1111-4111-8111-111111111111",
    });
  });

  it("parses offer document list, render, and download routes for every document state", () => {
    const listed = platformCommercialContracts.offers.documents.list.response.parse([
      { ...pendingDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { ...readyDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { ...failedDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ]);
    expect(listed.map((document) => document.status)).toEqual(["pending", "ready", "failed"]);
    expect(
      platformCommercialContracts.offers.documents.render.response.parse({
        revision: 2,
        documents: [readyDocument, failedDocument],
      }).documents,
    ).toHaveLength(2);
    expect(
      platformCommercialContracts.offers.documents.download.response.parse({
        url: "https://objects.example.invalid/offers/offer.pdf?signature=redacted",
      }).url,
    ).toContain("offer.pdf");
  });

  it("parses every invoice success route with exact statuses and invoice activation spelling", () => {
    const list = platformCommercialContracts.invoices.list.response.parse({
      items: [
        { ...invoiceBase, status: "draft" },
        {
          ...invoiceBase,
          id: "32111111-1111-4111-8111-111111111111",
          status: "issued",
          issueDate: CREATED_AT,
          sellerSnapshot: { displayName: "Markiro" },
          buyerSnapshot: { displayName: "Factory" },
          issuedAt: CREATED_AT,
          issuedByPlatformUserId: PLATFORM_USER_ID,
        },
        {
          ...invoiceBase,
          id: "33111111-1111-4111-8111-111111111111",
          status: "paid",
          issueDate: CREATED_AT,
          sellerSnapshot: { displayName: "Markiro" },
          buyerSnapshot: { displayName: "Factory" },
          issuedAt: CREATED_AT,
          issuedByPlatformUserId: PLATFORM_USER_ID,
          paidAt: CREATED_AT,
        },
        {
          ...invoiceBase,
          id: "34111111-1111-4111-8111-111111111111",
          status: "cancelled",
          cancelledAt: CREATED_AT,
        },
      ],
    });
    expect(list.items.map((invoice) => invoice.status)).toEqual([
      "draft",
      "issued",
      "paid",
      "cancelled",
    ]);

    const detail = platformCommercialContracts.invoices.detail.response.parse({
      ...invoiceBase,
      status: "paid",
      issueDate: CREATED_AT,
      sellerSnapshot: { displayName: "Markiro" },
      buyerSnapshot: { displayName: "Factory" },
      issuedAt: CREATED_AT,
      issuedByPlatformUserId: PLATFORM_USER_ID,
      paidAt: CREATED_AT,
      lines: [
        invoiceLine,
        {
          ...invoiceLine,
          id: "42111111-1111-4111-8111-111111111111",
          activationPolicy: "immediate",
        },
        {
          ...invoiceLine,
          id: "43111111-1111-4111-8111-111111111111",
          activationPolicy: "after_current",
        },
      ],
      documents: [
        {
          ...readyDocument,
          tenantId: TENANT_ID,
          invoiceId: INVOICE_ID,
          objectKey: "tenants/redacted/invoices/redacted/r1.pdf",
          rendererVersion: "billing-print-v1",
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
        },
      ],
      payment: billingPayment,
      application: {
        status: "applied",
        latestByLine: [applicationEvent],
        attempts: [applicationEvent],
      },
    });
    expect(detail.lines.map((line) => line.activationPolicy)).toEqual([
      "manual",
      "immediate",
      "after_current",
    ]);
    expect(detail.application.attempts[0]?.status).toBe("skipped");

    expect(
      platformCommercialContracts.invoices.create.response.parse({
        ...invoiceBase,
        status: "draft",
        lines: 1,
      }).status,
    ).toBe("draft");
    expect(
      platformCommercialContracts.invoices.issue.response.parse({
        ...invoiceBase,
        status: "issued",
        issueDate: CREATED_AT,
        sellerSnapshot: { displayName: "Markiro" },
        buyerSnapshot: { displayName: "Factory" },
        issuedAt: CREATED_AT,
        issuedByPlatformUserId: PLATFORM_USER_ID,
        documents: { revision: 1, documents: [readyDocument] },
      }).status,
    ).toBe("issued");
    expect(
      platformCommercialContracts.invoices.cancel.response.parse({
        ...invoiceBase,
        status: "cancelled",
        cancelledAt: CREATED_AT,
      }).status,
    ).toBe("cancelled");
    const applied = platformCommercialContracts.invoices.apply.response.parse({
      invoiceId: INVOICE_ID,
      status: "applied",
      results: [
        {
          lineId: INVOICE_LINE_ID,
          attempt: 1,
          status: "skipped",
          kind: "plan",
          result: { id: "a1111111-1111-4111-8111-111111111111" },
          errorCode: null,
        },
      ],
    });
    expect(applied.results[0]?.status).toBe("skipped");
  });

  it("parses every invoice document route including the legacy render and latest URL variants", () => {
    const list = platformCommercialContracts.invoices.documents.list.response.parse([
      { ...pendingDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { ...readyDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
      { ...failedDocument, createdAt: CREATED_AT, updatedAt: CREATED_AT },
    ]);
    expect(list.map((document) => document.status)).toEqual(["pending", "ready", "failed"]);

    const renderResult = { revision: 3, documents: [readyDocument, failedDocument] };
    expect(
      platformCommercialContracts.invoices.document.response.parse(renderResult).revision,
    ).toBe(3);
    expect(
      platformCommercialContracts.invoices.documents.render.response.parse(renderResult).documents,
    ).toHaveLength(2);
    for (const contract of [
      platformCommercialContracts.invoices.documentUrl,
      platformCommercialContracts.invoices.documents.download,
    ]) {
      expect(
        contract.response.parse({
          url: "https://objects.example.invalid/invoices/invoice.pdf?signature=redacted",
        }).url,
      ).toContain("invoice.pdf");
    }
  });

  it("parses manual and imported payment routes", () => {
    const importedPayment = {
      ...billingPayment,
      id: "62111111-1111-4111-8111-111111111111",
      source: "bank_import",
      importRowId: "63111111-1111-4111-8111-111111111111",
      idempotencyKey: "bank-import-row-1",
    } as const;
    const list = platformCommercialContracts.payments.list.response.parse({
      items: [billingPayment, importedPayment],
    });
    expect(list.items.map((payment) => payment.source)).toEqual(["manual", "bank_import"]);
    expect(platformCommercialContracts.payments.manual.response.parse(billingPayment).source).toBe(
      "manual",
    );
    expect(
      platformCommercialContracts.payments.import.response.parse({
        id: "64111111-1111-4111-8111-111111111111",
        source: "bank_import",
        sourceChecksum: "b".repeat(64),
        fileName: "payments.csv",
        parserVersion: "bank-csv-v1",
        status: "ready",
        rowCount: 2,
        errorCount: 1,
        createdByPlatformUserId: PLATFORM_USER_ID,
        createdAt: CREATED_AT,
      }).status,
    ).toBe("ready");
  });

  it("validates offer and invoice request activation policies without normalizing spellings", () => {
    const offer = platformCommercialContracts.offers.create.body.parse({
      tenantId: TENANT_ID,
      expiresAt: "2026-09-15",
      termsMarkdown: null,
      lines: [
        {
          kind: "plan",
          catalogVersionId: CATALOG_VERSION_ID,
          nameRu: "Производство",
          nameEn: "Production",
          quantity: 1,
          unit: "month",
          agreedUnitPrice: "15000.00",
          vatRateBps: 2000,
          vatIncluded: true,
          priceOverrideReason: null,
          activationPolicy: "immediately",
        },
        {
          kind: "plan",
          catalogVersionId: "72111111-1111-4111-8111-111111111111",
          nameRu: "Следующий",
          nameEn: "Next",
          quantity: 1,
          unit: "month",
          agreedUnitPrice: "15000.00",
          vatRateBps: 2000,
          vatIncluded: true,
          priceOverrideReason: null,
          activationPolicy: "after_current",
        },
      ],
    });
    expect(offer.lines.map((line) => line.activationPolicy)).toEqual([
      "immediately",
      "after_current",
    ]);

    const invoice = platformCommercialContracts.invoices.create.body.parse({
      tenantId: TENANT_ID,
      dueDate: "2026-09-30",
      applicationMode: "automatic",
      lines: ["immediate", "after_current", "manual"].map((activationPolicy, index) => ({
        kind: "plan",
        catalogVersionId: `73111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
        nameRu: "Производство",
        nameEn: "Production",
        quantity: 1,
        unit: "month",
        agreedUnitPrice: "15000.00",
        vatRateBps: 2000,
        vatIncluded: true,
        activationPolicy,
      })),
    });
    expect(invoice.lines.map((line) => line.activationPolicy)).toEqual([
      "immediate",
      "after_current",
      "manual",
    ]);

    expect(
      platformCommercialContracts.offers.create.body.safeParse({
        ...offer,
        lines: [{ ...offer.lines[0], activationPolicy: "immediate" }],
      }).success,
    ).toBe(false);
    expect(
      platformCommercialContracts.invoices.create.body.safeParse({
        ...invoice,
        lines: [{ ...invoice.lines[0], activationPolicy: "immediately" }],
      }).success,
    ).toBe(false);
  });
});
