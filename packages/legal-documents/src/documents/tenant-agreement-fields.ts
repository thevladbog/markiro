export type PartyKind = "individual" | "self_employed" | "sole_proprietor" | "legal_entity";

export interface PartyRequisites {
  readonly kind: PartyKind;
  readonly name: string;
  readonly inn: string | null;
  readonly kpp: string | null;
  readonly ogrn: string | null;
  readonly address: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly bankName: string | null;
  readonly bic: string | null;
  readonly settlementAccount: string | null;
  readonly correspondentAccount: string | null;
  readonly taxRegime: string | null;
}

export interface AgreementSignatory {
  readonly position: string | null;
  readonly fullName: string | null;
  readonly authorityBasis: string | null;
}

export interface AgreementTerms {
  readonly disputeVenue: string | null;
  readonly penaltyRatePercent: string | null;
  readonly penaltyCapPercent: string | null;
}

export interface TenantAgreementFields {
  readonly number?: string;
  /** Civil date, `YYYY-MM-DD`. Printed as `DD.MM.YYYY`. */
  readonly conclusionDate?: string;
  readonly city?: string;
  readonly contractor?: PartyRequisites;
  readonly customer: PartyRequisites;
  readonly signatory?: AgreementSignatory;
  readonly terms?: AgreementTerms;
}

/**
 * Falls back to the literal the static draft used, so a half-filled
 * agreement still prints something a lawyer recognises as unfilled.
 */
export function agreementField(value: string | null | undefined, placeholder: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : placeholder;
}

export function agreementDate(value: string | null | undefined, placeholder: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value?.trim() ?? "");
  if (!match) return placeholder;
  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function isSoleProprietorOrIndividual(kind: PartyKind): boolean {
  return kind !== "legal_entity";
}
