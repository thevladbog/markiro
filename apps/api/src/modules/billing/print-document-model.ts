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
  sellerBankAccountSnapshot?: unknown;
  buyerBankAccountSnapshot?: unknown;
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
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const text = (value: unknown, fallback = "") =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback;
const optionalText = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

const party = (profileValue: unknown, accountValue: unknown): BillingProfileSnapshot => {
  const source = profile(profileValue);
  const contact = record(source.contact);
  const legacyBankDetails = record(source.bankDetails);
  const account = { ...legacyBankDetails, ...record(accountValue) };
  return {
    ...source,
    legalName: optionalText(source.legalName, source.fullName),
    taxId: optionalText(source.taxId, source.inn),
    registrationId: optionalText(source.registrationId, source.ogrn, source.ogrnip),
    address: optionalText(source.address, source.legalAddressRaw),
    bankAccount: optionalText(source.bankAccount, account.settlementAccount),
    bankName: optionalText(source.bankName, account.bankName),
    correspondentAccount: optionalText(source.correspondentAccount, account.correspondentAccount),
    phone: optionalText(source.phone, contact.phone),
    email: optionalText(source.email, contact.email),
  };
};

export function toInvoicePrintModel(invoice: InvoiceLike): PrintDocumentModel {
  return {
    kind: "invoice",
    number: invoice.number,
    status: invoice.status,
    issuedOrPublishedAt: invoice.issueDate ?? new Date(0),
    dueOrExpiresAt: invoice.dueDate,
    seller: party(invoice.sellerSnapshot, invoice.sellerBankAccountSnapshot),
    buyer: party(invoice.buyerSnapshot, invoice.buyerBankAccountSnapshot),
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
  sellerBankAccountSnapshot?: unknown;
  buyerBankAccountSnapshot?: unknown;
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
    seller: party(snapshot.sellerSnapshot, snapshot.sellerBankAccountSnapshot),
    buyer: party(snapshot.buyerSnapshot, snapshot.buyerBankAccountSnapshot),
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
