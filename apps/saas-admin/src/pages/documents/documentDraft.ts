import type { CatalogVersionDto } from "../catalog/api.js";
import type {
  CreateInvoiceInput,
  CreateInvoiceLineInput,
  CreateOfferInput,
  CreateOfferLineInput,
  DocumentKind,
  DocumentDraft,
  DocumentDraftAction,
  DocumentLineDraft,
} from "./types.js";

export type {
  ActivationPolicy,
  CreateInvoiceInput,
  CreateOfferInput,
  DocumentDraft,
  DocumentDraftAction,
  DocumentLineDraft,
} from "./types.js";

export type { DocumentKind } from "./types.js";

const MONEY_PATTERN = /^\d{1,12}\.\d{2}$/;
const MAX_LINES = 100;

export function createLineFromCatalog(version: CatalogVersionDto, id: string): DocumentLineDraft {
  if (!version.unitPrice) throw new Error("catalog_version_financial_terms_missing");

  const vatRateBps = version.vatRateBps ?? null;
  return {
    id,
    kind: version.kind,
    catalogVersionId: version.id,
    catalogItemCode: version.catalogItemCode,
    version: version.version,
    nameRu: version.nameRu,
    nameEn: version.nameEn,
    quantity: 1,
    unit: version.unit,
    agreedUnitPrice: version.unitPrice,
    vatRateBps,
    vatIncluded: vatRateBps !== null && version.vatIncluded === true,
    activationPolicy: version.kind === "service" ? null : "immediate",
  };
}

export function documentDraftReducer(
  draft: DocumentDraft,
  action: DocumentDraftAction,
): DocumentDraft {
  switch (action.type) {
    case "tenant.selected":
      return { ...draft, tenantId: action.tenantId };
    case "catalog.added": {
      const existingIndex = draft.lines.findIndex(
        (line) => line.catalogVersionId === action.version.id,
      );
      if (!action.separate && existingIndex !== -1) {
        return updateLine(draft, existingIndex, (line) => ({
          ...line,
          quantity: line.quantity + 1,
        }));
      }
      if (draft.lines.length >= MAX_LINES) return draft;
      if (!action.id) throw new Error("document_line_id_required");
      if (draft.lines.some((line) => line.id === action.id))
        throw new Error("document_line_id_duplicate");
      return {
        ...draft,
        lines: [...draft.lines, createLineFromCatalog(action.version, action.id)],
      };
    }
    case "line.quantityChanged":
      return updateLineById(draft, action.id, (line) => ({ ...line, quantity: action.quantity }));
    case "line.priceChanged":
      return updateLineById(draft, action.id, (line) => ({ ...line, agreedUnitPrice: action.price }));
    case "line.vatIncludedChanged":
      return updateLineById(draft, action.id, (line) => ({
        ...line,
        vatIncluded: line.vatRateBps !== null && action.included,
      }));
    case "line.policyChanged":
      return updateLineById(draft, action.id, (line) =>
        line.kind === "service" ? line : { ...line, activationPolicy: action.policy },
      );
    case "line.moved": {
      const index = draft.lines.findIndex((line) => line.id === action.id);
      const target = index + action.direction;
      if (index === -1 || target < 0 || target >= draft.lines.length) return draft;
      const lines = [...draft.lines];
      const source = lines[index];
      const destination = lines[target];
      if (!source || !destination) return draft;
      lines[index] = destination;
      lines[target] = source;
      return { ...draft, lines };
    }
    case "line.removed":
      return { ...draft, lines: draft.lines.filter((line) => line.id !== action.id) };
  }
}

export function calculateDocumentTotals(
  lines: readonly DocumentLineDraft[],
  kind?: DocumentKind,
): {
  subtotal: string;
  vatTotal: string;
  total: string;
};
export function calculateDocumentTotals(
  kind: DocumentKind,
  lines: readonly DocumentLineDraft[],
): {
  subtotal: string;
  vatTotal: string;
  total: string;
};
export function calculateDocumentTotals(
  linesOrKind: readonly DocumentLineDraft[] | DocumentKind,
  kindOrLines: DocumentKind | readonly DocumentLineDraft[] = "invoice",
): {
  subtotal: string;
  vatTotal: string;
  total: string;
} {
  const kind =
    typeof linesOrKind === "string" ? linesOrKind : (kindOrLines as DocumentKind);
  const lines =
    typeof linesOrKind === "string"
      ? (kindOrLines as readonly DocumentLineDraft[])
      : linesOrKind;
  let subtotal = 0n;
  let vatTotal = 0n;
  let total = 0n;

  for (const line of lines) {
    const quantity = BigInt(positiveInteger(line.quantity));
    const price = parseMoney(line.agreedUnitPrice);
    const rate = vatRate(line.vatRateBps);
    const gross = price * quantity;
    const lineTotal =
      kind === "offer"
        ? offerLineTotal(gross, rate, line.vatIncluded, line.vatRateBps)
        : line.vatIncluded
          ? gross
          : gross + (gross * rate) / 10_000n;
    const vat =
      line.vatIncluded
        ? (gross * rate) / (10_000n + rate)
        : kind === "offer"
          ? lineTotal - gross
          : (gross * rate) / 10_000n;
    const lineSubtotal = line.vatIncluded ? gross - vat : gross;

    subtotal += lineSubtotal;
    vatTotal += vat;
    total += lineTotal;
  }

  return { subtotal: formatMoney(subtotal), vatTotal: formatMoney(vatTotal), total: formatMoney(total) };
}

export function validateDocumentDraft(draft: DocumentDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.tenantId.trim()) errors.tenantId = "tenant_required";
  if (draft.lines.length === 0) errors.lines = "at_least_one_line_required";
  if (draft.lines.length > MAX_LINES) errors.lines = "too_many_lines";

  for (const line of draft.lines) {
    const prefix = `lines.${line.id}`;
    if (!Number.isInteger(line.quantity) || line.quantity < 1)
      errors[`${prefix}.quantity`] = "quantity_must_be_positive_integer";
    if (!MONEY_PATTERN.test(line.agreedUnitPrice))
      errors[`${prefix}.agreedUnitPrice`] = "money_must_have_two_decimal_places";
    if (
      line.vatRateBps !== null &&
      (!Number.isInteger(line.vatRateBps) || line.vatRateBps < 0 || line.vatRateBps > 10_000)
    )
      errors[`${prefix}.vatRateBps`] = "vat_rate_must_be_between_0_and_10000";
    if (line.kind === "service") {
      if (line.activationPolicy !== null)
        errors[`${prefix}.activationPolicy`] = "service_activation_policy_must_be_null";
    } else if (line.activationPolicy === null) {
      errors[`${prefix}.activationPolicy`] = "activation_policy_required";
    }
  }
  return errors;
}

export function toInvoiceCreateInput(draft: DocumentDraft): CreateInvoiceInput {
  return {
    tenantId: draft.tenantId,
    dueDate: optionalDate(draft.date),
    applicationMode: draft.applicationMode,
    lines: draft.lines.map(toInvoiceLine),
  };
}

export function toOfferCreateInput(draft: DocumentDraft): CreateOfferInput {
  return {
    tenantId: draft.tenantId,
    expiresAt: optionalDate(draft.date),
    lines: draft.lines.map(toOfferLine),
  };
}

function toInvoiceLine(line: DocumentLineDraft): CreateInvoiceLineInput {
  return {
    kind: line.kind,
    catalogVersionId: line.catalogVersionId,
    nameRu: line.nameRu,
    nameEn: line.nameEn,
    quantity: line.quantity,
    unit: line.unit,
    agreedUnitPrice: line.agreedUnitPrice,
    vatRateBps: line.vatRateBps,
    vatIncluded: line.vatIncluded,
    activationPolicy: line.kind === "service" ? null : line.activationPolicy,
  };
}

function toOfferLine(line: DocumentLineDraft): CreateOfferLineInput {
  if (line.kind !== "service" && line.activationPolicy === "manual")
    throw new Error("offer_manual_activation_policy_unsupported");
  if (line.kind !== "service" && line.activationPolicy === null)
    throw new Error("activation_policy_required");
  return {
    kind: line.kind,
    catalogVersionId: line.catalogVersionId,
    nameRu: line.nameRu,
    nameEn: line.nameEn,
    quantity: line.quantity,
    unit: line.unit,
    agreedUnitPrice: line.agreedUnitPrice,
    vatRateBps: line.vatRateBps,
    vatIncluded: line.vatIncluded,
    activationPolicy:
      line.kind === "service"
        ? null
        : line.activationPolicy === "after_current"
          ? "after_current"
          : "immediately",
  };
}

function updateLine(
  draft: DocumentDraft,
  index: number,
  update: (line: DocumentLineDraft) => DocumentLineDraft,
): DocumentDraft {
  const line = draft.lines[index];
  if (!line) return draft;
  const lines = [...draft.lines];
  lines[index] = update(line);
  return { ...draft, lines };
}

function updateLineById(
  draft: DocumentDraft,
  id: string,
  update: (line: DocumentLineDraft) => DocumentLineDraft,
): DocumentDraft {
  return updateLine(draft, draft.lines.findIndex((line) => line.id === id), update);
}

function positiveInteger(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("quantity_must_be_positive_integer");
  return value;
}

function vatRate(value: number | null): bigint {
  if (value === null) return 0n;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10_000)
    throw new Error("vat_rate_must_be_between_0_and_10000");
  return BigInt(value);
}

function offerLineTotal(
  gross: bigint,
  rate: bigint,
  vatIncluded: boolean,
  vatRateBps: number | null,
): bigint {
  if (vatIncluded || vatRateBps === null) return gross;
  return (gross * (10_000n + rate) + 5_000n) / 10_000n;
}

function parseMoney(value: string): bigint {
  if (!MONEY_PATTERN.test(value)) throw new Error("money_must_have_two_decimal_places");
  const [whole, cents] = value.split(".");
  return BigInt(whole!) * 100n + BigInt(cents!);
}

function formatMoney(value: bigint): string {
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function optionalDate(value: string): string | null {
  return value.trim() ? value : null;
}
