export type PrintDocumentKind = "invoice" | "offer";

export interface BillingProfileSnapshot {
  legalName?: string | null;
  taxId?: string | null;
  registrationId?: string | null;
  address?: string | null;
  bankAccount?: string | null;
  bankName?: string | null;
  correspondentAccount?: string | null;
  phone?: string | null;
  email?: string | null;
  [key: string]: unknown;
}

export interface PrintLine {
  position: number;
  name: string;
  description?: string | null;
  unit: string;
  quantity: number;
  unitPrice: string;
  vatRate?: string | null;
  vatIncluded: boolean;
  lineTotal: string;
}

export interface PrintDocumentModel {
  kind: PrintDocumentKind;
  number: string;
  status: string;
  issuedOrPublishedAt: Date;
  dueOrExpiresAt: Date | null;
  seller: BillingProfileSnapshot;
  buyer: BillingProfileSnapshot;
  lines: PrintLine[];
  subtotal: string;
  vatTotal: string;
  total: string;
  termsHtml: string | null;
}

type InvoiceLike = {
  number: string;
  status: string;
  issueDate: Date | null;
  dueDate: Date | null;
  sellerSnapshot: unknown;
  buyerSnapshot: unknown;
  subtotal: string;
  vatTotal: string;
  total: string;
  lines: Array<{
    position: number;
    nameRu: string;
    descriptionRu?: string | null;
    unit: string;
    quantity: number;
    agreedUnitPrice: string;
    vatRate?: string | null;
    vatIncluded: boolean;
    lineTotal: string;
  }>;
};

const profile = (value: unknown): BillingProfileSnapshot =>
  value && typeof value === "object" ? (value as BillingProfileSnapshot) : {};
const text = (value: unknown, fallback = "") =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback;

export function toInvoicePrintModel(invoice: InvoiceLike): PrintDocumentModel {
  return {
    kind: "invoice",
    number: invoice.number,
    status: invoice.status,
    issuedOrPublishedAt: invoice.issueDate ?? new Date(0),
    dueOrExpiresAt: invoice.dueDate,
    seller: profile(invoice.sellerSnapshot),
    buyer: profile(invoice.buyerSnapshot),
    lines: invoice.lines.map((line) => ({
      position: line.position,
      name: line.nameRu,
      description: line.descriptionRu ?? null,
      unit: line.unit,
      quantity: line.quantity,
      unitPrice: line.agreedUnitPrice,
      vatRate: line.vatRate ?? null,
      vatIncluded: line.vatIncluded,
      lineTotal: line.lineTotal,
    })),
    subtotal: invoice.subtotal,
    vatTotal: invoice.vatTotal,
    total: invoice.total,
    termsHtml: null,
  };
}

export function toOfferPrintModel(snapshot: {
  number: string;
  status: string;
  publishedAt: Date;
  expiresAt: Date | null;
  sellerSnapshot: unknown;
  buyerSnapshot: unknown;
  linesSnapshot: unknown;
  subtotal: string;
  vatTotal: string;
  total: string;
  termsHtml: string | null;
}): PrintDocumentModel {
  const lines = Array.isArray(snapshot.linesSnapshot) ? snapshot.linesSnapshot : [];
  return {
    kind: "offer",
    number: snapshot.number,
    status: snapshot.status,
    issuedOrPublishedAt: snapshot.publishedAt,
    dueOrExpiresAt: snapshot.expiresAt,
    seller: profile(snapshot.sellerSnapshot),
    buyer: profile(snapshot.buyerSnapshot),
    lines: lines.map((line, index) => {
      const item = line as Record<string, unknown>;
      return {
        position: Number(item.position ?? index + 1),
        name: text(item.nameRu),
        description: typeof item.descriptionRu === "string" ? item.descriptionRu : null,
        unit: text(item.unit),
        quantity: Number(item.quantity ?? 0),
        unitPrice: text(item.agreedUnitPrice, "0.00"),
        vatRate: typeof item.vatRate === "string" ? item.vatRate : null,
        vatIncluded: item.vatIncluded === true,
        lineTotal: text(item.lineTotal, "0.00"),
      };
    }),
    subtotal: snapshot.subtotal,
    vatTotal: snapshot.vatTotal,
    total: snapshot.total,
    termsHtml: snapshot.termsHtml,
  };
}
