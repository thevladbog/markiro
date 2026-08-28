import type {
  CatalogVersion,
  CreateInvoiceInput as SharedCreateInvoiceInput,
  CreateOfferInput as SharedCreateOfferInput,
} from "@markiro/platform-contracts";

export type DocumentKind = "invoice" | "offer";
export type ActivationPolicy = "immediate" | "after_current" | "manual";

export interface DocumentLineDraft {
  id: string;
  kind: "plan" | "addon" | "service" | "custom";
  catalogVersionId: string | null;
  catalogItemCode: string;
  version: number;
  nameRu: string;
  nameEn: string;
  descriptionRu?: string | null;
  descriptionEn?: string | null;
  quantity: number;
  unit: string;
  catalogUnitPrice?: string | null;
  agreedUnitPrice: string;
  priceOverrideReason?: string | null;
  vatRateBps: number | null;
  vatIncluded: boolean;
  activationPolicy: ActivationPolicy | null;
}

export interface DocumentDraft {
  tenantId: string;
  sourceOfferId?: string;
  sourceRequestId?: string;
  sellerBankAccountId?: string | null;
  applicationMode: "manual" | "automatic";
  date: string;
  termsMarkdown?: string | null;
  lines: DocumentLineDraft[];
}

export type DocumentDraftAction =
  | { type: "tenant.selected"; tenantId: string }
  | { type: "sellerAccount.selected"; accountId: string }
  | { type: "catalog.added"; version: CatalogVersion; separate?: boolean; id: string }
  | { type: "line.quantityChanged"; id: string; quantity: number }
  | { type: "line.priceChanged"; id: string; price: string }
  | { type: "line.descriptionChanged"; id: string; description: string }
  | { type: "line.priceOverrideReasonChanged"; id: string; reason: string }
  | { type: "line.vatIncludedChanged"; id: string; included: boolean }
  | { type: "line.policyChanged"; id: string; policy: ActivationPolicy }
  | { type: "line.moved"; id: string; direction: -1 | 1 }
  | { type: "line.removed"; id: string };

export type CreateInvoiceInput = SharedCreateInvoiceInput;
export type CreateInvoiceLineInput = CreateInvoiceInput["lines"][number];
export type CreateOfferInput = SharedCreateOfferInput;
export type CreateOfferLineInput = CreateOfferInput["lines"][number];
