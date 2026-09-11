import type { PartyRequisites, TenantAgreementFields } from "@markiro/legal-documents";
import type {
  AgreementRequisitesInput,
  AgreementSignatory,
  AgreementTerms,
} from "./agreement-state";

/**
 * The JSONB columns hold whatever revision wrote them, so every key is
 * normalised to `null` here. `undefined` reaching the template would print an
 * empty cell instead of the placeholder that tells a reader the field is
 * unfilled.
 */
export function toPartyRequisites(source: AgreementRequisitesInput): PartyRequisites {
  return {
    kind: source.kind,
    name: source.name,
    inn: source.inn ?? null,
    kpp: "kpp" in source ? (source.kpp ?? null) : null,
    ogrn: "ogrn" in source ? (source.ogrn ?? null) : "ogrnip" in source ? source.ogrnip : null,
    address: source.address ?? null,
    email: source.email ?? null,
    phone: source.phone ?? null,
    bankName: source.bankName ?? null,
    bic: source.bic ?? null,
    settlementAccount: source.settlementAccount ?? null,
    correspondentAccount: source.correspondentAccount ?? null,
    taxRegime: null,
  };
}

export interface AgreementFieldSource {
  readonly number: string;
  readonly conclusionDate: string | null;
  readonly city: string | null;
  readonly counterparty: AgreementRequisitesInput;
  readonly contractor: AgreementRequisitesInput;
  readonly signatory: AgreementSignatory;
  readonly terms: AgreementTerms;
}

export function toAgreementFields(source: AgreementFieldSource): TenantAgreementFields {
  return {
    number: source.number,
    ...(source.conclusionDate === null ? {} : { conclusionDate: source.conclusionDate }),
    ...(source.city === null ? {} : { city: source.city }),
    customer: toPartyRequisites(source.counterparty),
    // The operator profile carries no tax-regime field, so nothing is
    // asserted here; the template's own default decides what prints, in one
    // place rather than two.
    contractor: toPartyRequisites(source.contractor),
    signatory: source.signatory,
    terms: source.terms,
  };
}
