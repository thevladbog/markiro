import { describe, expect, it } from "vitest";

import { invoiceApplicationEventSchema, platformCommercialContracts } from "../src/index.js";
import { invoiceDocumentRecordSchema } from "../src/commercial.js";

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

const publishedOfferMetadata = {
  number: "KP-2026-000001",
  publishedAt: CREATED_AT,
  publishedByPlatformUserId: PLATFORM_USER_ID,
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

const issuedInvoiceMetadata = {
  issueDate: CREATED_AT,
  sellerSnapshot: { displayName: "Markiro" },
  buyerSnapshot: { displayName: "Factory" },
  sellerBankAccountSnapshot: null,
  buyerBankAccountSnapshot: null,
  issuedAt: CREATED_AT,
  issuedByPlatformUserId: PLATFORM_USER_ID,
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
        ...publishedOfferMetadata,
      },
      {
        ...offerBase,
        id: "13111111-1111-4111-8111-111111111111",
        status: "paid",
        ...publishedOfferMetadata,
        paidAt: CREATED_AT,
      },
      {
        ...offerBase,
        id: "14111111-1111-4111-8111-111111111111",
        status: "cancelled",
        ...publishedOfferMetadata,
      },
      {
        ...offerBase,
        id: "15111111-1111-4111-8111-111111111111",
        status: "expired",
        ...publishedOfferMetadata,
      },
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
        ...publishedOfferMetadata,
        lines: [offerLine],
        documents: { revision: 1, documents: [readyDocument, failedDocument] },
      }).status,
    ).toBe("published");
    expect(
      platformCommercialContracts.offers.cancel.response.parse({
        ...offerBase,
        status: "cancelled",
        ...publishedOfferMetadata,
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

  it("rejects offer lifecycle metadata that contradicts every status", () => {
    const draft = { ...offerBase, status: "draft" } as const;
    const published = {
      ...offerBase,
      ...publishedOfferMetadata,
      status: "published",
    } as const;
    const paid = {
      ...offerBase,
      ...publishedOfferMetadata,
      status: "paid",
      paidAt: CREATED_AT,
    } as const;
    const cancelled = {
      ...offerBase,
      ...publishedOfferMetadata,
      status: "cancelled",
    } as const;
    const expired = { ...offerBase, ...publishedOfferMetadata, status: "expired" } as const;
    const contract = platformCommercialContracts.offers.list.response;

    expect(contract.parse([draft, published, paid, cancelled, expired])).toHaveLength(5);

    const invalid = [
      ["draft number", { ...draft, number: "KP-2026-000001" }],
      ["draft publishedAt", { ...draft, publishedAt: CREATED_AT }],
      ["draft publisher", { ...draft, publishedByPlatformUserId: PLATFORM_USER_ID }],
      ["draft paidAt", { ...draft, paidAt: CREATED_AT }],
      ["published number", { ...published, number: null }],
      ["published publishedAt", { ...published, publishedAt: null }],
      ["published publisher", { ...published, publishedByPlatformUserId: null }],
      ["published paidAt", { ...published, paidAt: CREATED_AT }],
      ["paid number", { ...paid, number: null }],
      ["paid publishedAt", { ...paid, publishedAt: null }],
      ["paid publisher", { ...paid, publishedByPlatformUserId: null }],
      ["paid paidAt", { ...paid, paidAt: null }],
      ["cancelled number", { ...cancelled, number: null }],
      ["cancelled publishedAt", { ...cancelled, publishedAt: null }],
      ["cancelled publisher", { ...cancelled, publishedByPlatformUserId: null }],
      ["cancelled paidAt", { ...cancelled, paidAt: CREATED_AT }],
      ["expired number", { ...expired, number: null }],
      ["expired publishedAt", { ...expired, publishedAt: null }],
      ["expired publisher", { ...expired, publishedByPlatformUserId: null }],
      ["expired paidAt", { ...expired, paidAt: CREATED_AT }],
    ] as const;

    for (const [name, candidate] of invalid) {
      expect(contract.safeParse([candidate]).success, name).toBe(false);
    }
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

  it("rejects document metadata that contradicts every rendering state", () => {
    const contract = platformCommercialContracts.offers.documents.list.response;
    const listed = (document: object) => ({
      ...document,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
    const invalid = [
      ["pending contentType", { ...pendingDocument, contentType: "text/html" }],
      ["pending byteSize", { ...pendingDocument, byteSize: 1 }],
      ["pending sha256", { ...pendingDocument, sha256: "a".repeat(64) }],
      ["pending errorCode", { ...pendingDocument, errorCode: "render_failed" }],
      ["ready contentType", { ...readyDocument, contentType: null }],
      ["ready byteSize", { ...readyDocument, byteSize: null }],
      ["ready sha256", { ...readyDocument, sha256: null }],
      ["ready errorCode", { ...readyDocument, errorCode: "render_failed" }],
      ["failed contentType", { ...failedDocument, contentType: "text/html" }],
      ["failed byteSize", { ...failedDocument, byteSize: 1 }],
      ["failed sha256", { ...failedDocument, sha256: "a".repeat(64) }],
      ["failed errorCode", { ...failedDocument, errorCode: null }],
    ] as const;

    for (const [name, candidate] of invalid) {
      expect(contract.safeParse([listed(candidate)]).success, name).toBe(false);
    }

    const invoiceDocumentFields = {
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      rendererVersion: "billing-print-v1",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    } as const;
    expect(
      invoiceDocumentRecordSchema.parse({
        ...pendingDocument,
        ...invoiceDocumentFields,
        objectKey: null,
      }).status,
    ).toBe("pending");
    expect(
      invoiceDocumentRecordSchema.parse({
        ...readyDocument,
        ...invoiceDocumentFields,
        objectKey: "tenants/redacted/invoices/redacted/r1.pdf",
      }).status,
    ).toBe("ready");
    expect(
      invoiceDocumentRecordSchema.parse({
        ...failedDocument,
        ...invoiceDocumentFields,
        objectKey: null,
      }).status,
    ).toBe("failed");
    expect(
      invoiceDocumentRecordSchema.safeParse({
        ...failedDocument,
        ...invoiceDocumentFields,
        objectKey: "tenants/redacted/invoices/redacted/r1.pdf",
      }).success,
      "failed objectKey",
    ).toBe(false);
  });

  it("parses every invoice success route with exact statuses and invoice activation spelling", () => {
    const list = platformCommercialContracts.invoices.list.response.parse({
      items: [
        { ...invoiceBase, status: "draft" },
        {
          ...invoiceBase,
          id: "32111111-1111-4111-8111-111111111111",
          status: "issued",
          ...issuedInvoiceMetadata,
        },
        {
          ...invoiceBase,
          id: "33111111-1111-4111-8111-111111111111",
          status: "paid",
          ...issuedInvoiceMetadata,
          paidAt: CREATED_AT,
        },
        {
          ...invoiceBase,
          id: "34111111-1111-4111-8111-111111111111",
          status: "cancelled",
          ...issuedInvoiceMetadata,
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
      ...issuedInvoiceMetadata,
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
        ...issuedInvoiceMetadata,
        documents: { revision: 1, documents: [readyDocument] },
      }).status,
    ).toBe("issued");
    expect(
      platformCommercialContracts.invoices.cancel.response.parse({
        ...invoiceBase,
        status: "cancelled",
        ...issuedInvoiceMetadata,
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

  it("rejects invoice lifecycle metadata that contradicts every status", () => {
    const draft = { ...invoiceBase, status: "draft" } as const;
    const issued = { ...invoiceBase, ...issuedInvoiceMetadata, status: "issued" } as const;
    const paid = {
      ...invoiceBase,
      ...issuedInvoiceMetadata,
      status: "paid",
      paidAt: CREATED_AT,
    } as const;
    const cancelledIssued = {
      ...invoiceBase,
      ...issuedInvoiceMetadata,
      status: "cancelled",
      cancelledAt: CREATED_AT,
    } as const;
    const contract = platformCommercialContracts.invoices.list.response;

    expect(contract.parse({ items: [draft, issued, paid, cancelledIssued] }).items).toHaveLength(4);

    const cancelledWithoutIssuance = {
      ...invoiceBase,
      status: "cancelled",
      cancelledAt: CREATED_AT,
    } as const;

    const invalid = [
      ["draft issueDate", { ...draft, issueDate: CREATED_AT }],
      ["draft sellerSnapshot", { ...draft, sellerSnapshot: { displayName: "Markiro" } }],
      ["draft buyerSnapshot", { ...draft, buyerSnapshot: { displayName: "Factory" } }],
      ["draft issuedAt", { ...draft, issuedAt: CREATED_AT }],
      ["draft issuer", { ...draft, issuedByPlatformUserId: PLATFORM_USER_ID }],
      ["draft paidAt", { ...draft, paidAt: CREATED_AT }],
      ["draft cancelledAt", { ...draft, cancelledAt: CREATED_AT }],
      ["issued issueDate", { ...issued, issueDate: null }],
      ["issued sellerSnapshot", { ...issued, sellerSnapshot: null }],
      ["issued buyerSnapshot", { ...issued, buyerSnapshot: null }],
      ["issued issuedAt", { ...issued, issuedAt: null }],
      ["issued issuer", { ...issued, issuedByPlatformUserId: null }],
      ["issued paidAt", { ...issued, paidAt: CREATED_AT }],
      ["issued cancelledAt", { ...issued, cancelledAt: CREATED_AT }],
      ["paid issueDate", { ...paid, issueDate: null }],
      ["paid sellerSnapshot", { ...paid, sellerSnapshot: null }],
      ["paid buyerSnapshot", { ...paid, buyerSnapshot: null }],
      ["paid issuedAt", { ...paid, issuedAt: null }],
      ["paid issuer", { ...paid, issuedByPlatformUserId: null }],
      ["paid paidAt", { ...paid, paidAt: null }],
      ["paid cancelledAt", { ...paid, cancelledAt: CREATED_AT }],
      ["cancelled without issuance", cancelledWithoutIssuance],
      ["cancelled cancelledAt", { ...cancelledIssued, cancelledAt: null }],
      ["cancelled paidAt", { ...cancelledIssued, paidAt: CREATED_AT }],
      ["cancelled issued issueDate", { ...cancelledIssued, issueDate: null }],
      ["cancelled issued seller", { ...cancelledIssued, sellerSnapshot: null }],
      ["cancelled issued buyer", { ...cancelledIssued, buyerSnapshot: null }],
      ["cancelled issued issuedAt", { ...cancelledIssued, issuedAt: null }],
      ["cancelled issued issuer", { ...cancelledIssued, issuedByPlatformUserId: null }],
    ] as const;

    for (const [name, candidate] of invalid) {
      expect(contract.safeParse({ items: [candidate] }).success, name).toBe(false);
    }
  });

  it("rejects a paid invoice detail without its atomic payment and application state", () => {
    expect(
      platformCommercialContracts.invoices.detail.response.safeParse({
        ...invoiceBase,
        ...issuedInvoiceMetadata,
        status: "paid",
        paidAt: CREATED_AT,
        lines: [invoiceLine],
        documents: [],
        payment: null,
        application: {
          status: "not_paid",
          latestByLine: [],
          attempts: [],
        },
      }).success,
    ).toBe(false);
  });

  it("parses only the application states possible for each invoice detail status", () => {
    const relations = {
      lines: [invoiceLine],
      documents: [],
    } as const;
    const pendingEvent = {
      ...applicationEvent,
      status: "pending",
      afterSnapshot: null,
      errorCode: null,
    } as const;
    const appliedEvent = {
      ...applicationEvent,
      status: "applied",
      afterSnapshot: { id: OFFER_ID },
      errorCode: null,
    } as const;
    const failedEvent = {
      ...applicationEvent,
      status: "failed",
      afterSnapshot: null,
      errorCode: "activation_failed",
    } as const;
    const paidApplications = [
      { status: "pending", latestByLine: [pendingEvent], attempts: [pendingEvent] },
      { status: "partial_failure", latestByLine: [failedEvent], attempts: [failedEvent] },
      { status: "applied", latestByLine: [appliedEvent], attempts: [appliedEvent] },
      {
        status: "applied",
        latestByLine: [applicationEvent],
        attempts: [applicationEvent],
      },
    ] as const;

    for (const application of paidApplications) {
      const parsed = platformCommercialContracts.invoices.detail.response.parse({
        ...invoiceBase,
        ...issuedInvoiceMetadata,
        status: "paid",
        paidAt: CREATED_AT,
        ...relations,
        payment: billingPayment,
        application,
      });
      expect(parsed.application.status).toBe(application.status);
    }

    const unpaidRecords = [
      { name: "draft", record: { ...invoiceBase, status: "draft" } },
      {
        name: "issued",
        record: { ...invoiceBase, ...issuedInvoiceMetadata, status: "issued" },
      },
      {
        name: "cancelled",
        record: {
          ...invoiceBase,
          ...issuedInvoiceMetadata,
          status: "cancelled",
          cancelledAt: CREATED_AT,
        },
      },
    ] as const;
    const notPaidApplication = {
      status: "not_paid",
      latestByLine: [],
      attempts: [],
    } as const;

    for (const { name, record } of unpaidRecords) {
      const valid = { ...record, ...relations, payment: null, application: notPaidApplication };
      expect(
        platformCommercialContracts.invoices.detail.response.parse(valid).application.status,
        `${name} valid`,
      ).toBe("not_paid");
      expect(
        platformCommercialContracts.invoices.detail.response.safeParse({
          ...valid,
          payment: billingPayment,
        }).success,
        `${name} payment`,
      ).toBe(false);
      expect(
        platformCommercialContracts.invoices.detail.response.safeParse({
          ...valid,
          application: paidApplications[0],
        }).success,
        `${name} application`,
      ).toBe(false);
    }

    const paid = {
      ...invoiceBase,
      ...issuedInvoiceMetadata,
      status: "paid",
      paidAt: CREATED_AT,
      ...relations,
      payment: billingPayment,
      application: paidApplications[0],
    } as const;
    expect(
      platformCommercialContracts.invoices.detail.response.safeParse({
        ...paid,
        payment: null,
      }).success,
      "paid payment",
    ).toBe(false);
    expect(
      platformCommercialContracts.invoices.detail.response.safeParse({
        ...paid,
        application: notPaidApplication,
      }).success,
      "paid application",
    ).toBe(false);
  });

  it("rejects result and error metadata that contradicts every application state", () => {
    const resultBase = {
      lineId: INVOICE_LINE_ID,
      attempt: 1,
      kind: "plan",
    } as const;
    const results = [
      { ...resultBase, status: "pending", result: null, errorCode: null },
      { ...resultBase, status: "applied", result: { subscriptionId: OFFER_ID }, errorCode: null },
      { ...resultBase, status: "failed", result: null, errorCode: "activation_failed" },
      { ...resultBase, status: "skipped", result: { subscriptionId: OFFER_ID }, errorCode: null },
    ] as const;
    const response = (candidate: object) => ({
      invoiceId: INVOICE_ID,
      status: "partial_failure",
      results: [candidate],
    });

    expect(
      platformCommercialContracts.invoices.apply.response.parse({
        invoiceId: INVOICE_ID,
        status: "partial_failure",
        results,
      }).results,
    ).toHaveLength(4);

    const invalidResults = [
      ["pending result", { ...results[0], result: {} }],
      ["pending error", { ...results[0], errorCode: "activation_failed" }],
      ["applied result", { ...results[1], result: null }],
      ["applied error", { ...results[1], errorCode: "activation_failed" }],
      ["failed result", { ...results[2], result: {} }],
      ["failed error", { ...results[2], errorCode: null }],
      ["skipped result", { ...results[3], result: null }],
      ["skipped error", { ...results[3], errorCode: "activation_failed" }],
    ] as const;
    for (const [name, candidate] of invalidResults) {
      expect(
        platformCommercialContracts.invoices.apply.response.safeParse(response(candidate)).success,
        name,
      ).toBe(false);
    }

    const eventBase = {
      ...applicationEvent,
      beforeSnapshot: null,
    } as const;
    const events = [
      { ...eventBase, status: "pending", afterSnapshot: null, errorCode: null },
      { ...eventBase, status: "applied", afterSnapshot: { id: OFFER_ID }, errorCode: null },
      { ...eventBase, status: "failed", afterSnapshot: null, errorCode: "activation_failed" },
      { ...eventBase, status: "skipped", afterSnapshot: { id: OFFER_ID }, errorCode: null },
    ] as const;
    for (const event of events) expect(invoiceApplicationEventSchema.parse(event)).toBeTruthy();

    const invalidEvents = [
      ["pending snapshot", { ...events[0], afterSnapshot: {} }],
      ["pending error", { ...events[0], errorCode: "activation_failed" }],
      ["applied snapshot", { ...events[1], afterSnapshot: null }],
      ["applied error", { ...events[1], errorCode: "activation_failed" }],
      ["failed snapshot", { ...events[2], afterSnapshot: {} }],
      ["failed error", { ...events[2], errorCode: null }],
      ["skipped snapshot", { ...events[3], afterSnapshot: null }],
      ["skipped error", { ...events[3], errorCode: "activation_failed" }],
    ] as const;
    for (const [name, candidate] of invalidEvents) {
      expect(invoiceApplicationEventSchema.safeParse(candidate).success, name).toBe(false);
    }
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

  it("exposes only masked payer account evidence in payment matches", () => {
    const match = {
      id: "65111111-1111-4111-8111-111111111111",
      importId: "64111111-1111-4111-8111-111111111111",
      importRowId: "63111111-1111-4111-8111-111111111111",
      sourceRowId: "1",
      operationDate: CREATED_AT,
      amount: "15000.00",
      currency: "RUB",
      payerName: "ООО Покупатель",
      paymentPurpose: "Оплата INV-000021",
      bankReference: "BANK-21",
      tenantId: TENANT_ID,
      invoiceId: INVOICE_ID,
      invoiceNumber: "INV-000021",
      status: "needs_review",
      score: 80,
      reason: "unknown_payer_account",
      tenantBankAccountId: null,
      payerAccountEvidence: { kind: "unknown", last4: "9999" },
      decidedByPlatformUserId: null,
      decidedAt: null,
      createdAt: CREATED_AT,
    } as const;

    expect(
      platformCommercialContracts.payments.matches.list.response.parse({ items: [match] }).items[0]
        ?.payerAccountEvidence,
    ).toEqual({ kind: "unknown", last4: "9999" });
    expect(
      platformCommercialContracts.payments.matches.list.response.safeParse({
        items: [
          {
            ...match,
            payerAccountEvidence: {
              kind: "unknown",
              last4: "9999",
              settlementAccount: "40702810900000009999",
            },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      platformCommercialContracts.payments.matches.resolve.body.parse({
        decision: "matched",
        tenantId: TENANT_ID,
        invoiceId: INVOICE_ID,
        tenantBankAccountId: null,
        reason: "operator_verified_external_account",
      }),
    ).toMatchObject({ decision: "matched", tenantBankAccountId: null });
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
