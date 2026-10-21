import { TARIFF_CODES, type TariffCode } from "../content/pricing";

/** What the visitor asks for: the installer link on /skachat/ or an invoice on /stoimost/. */
export type LeadIntent = "download" | "invoice";

export interface DownloadLeadInput {
  readonly company: string;
  readonly email: string;
}

export interface InvoiceLeadInput {
  readonly email: string;
  readonly inn: string;
  readonly tariffCode: string;
}

export interface DownloadLead {
  readonly company: string;
  readonly email: string;
}

export interface InvoiceLead {
  readonly email: string;
  readonly inn: string;
  readonly tariffCode: TariffCode;
}

export type LeadField = "company" | "email" | "inn" | "tariffCode";
export type LeadErrors = Partial<Record<LeadField, string>>;

export type LeadValidation<T> =
  { readonly ok: true; readonly value: T } | { readonly errors: LeadErrors; readonly ok: false };

const EMAIL_MAX_LENGTH = 254;
const COMPANY_MAX_LENGTH = 120;
// Mirrors the default `z.email()` expression the API schemas use (see `lib/demo-form.ts`).
const EMAIL_PATTERN =
  /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+.-]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9-]*\.)+[A-Za-z]{2,}$/;

export const LEAD_COPY = {
  companyLong: "Название компании должно быть короче 121 символа",
  companyMissing: "Укажите компанию",
  emailDomain: "Проверьте почту: не хватает домена, например zavod.ru",
  emailInvalid: "Проверьте почту: в адресе есть лишние символы",
  emailLong: "Почта должна быть короче 255 символов",
  emailMissing: "Укажите рабочую почту",
  innChecksum: "Проверьте ИНН: не сходится контрольная цифра",
  innLength: "ИНН — 10 цифр для организации или 12 для ИП",
  innMissing: "Укажите ИНН организации",
  tariffMissing: "Выберите тариф",
} as const;

function validateEmail(source: string, errors: LeadErrors): string {
  const email = source.trim().toLowerCase();
  if (email.length === 0) errors.email = LEAD_COPY.emailMissing;
  else if (email.length > EMAIL_MAX_LENGTH) errors.email = LEAD_COPY.emailLong;
  else if (!EMAIL_PATTERN.test(email)) {
    const domain = email.split("@")[1] ?? "";
    errors.email = domain.includes(".") ? LEAD_COPY.emailInvalid : LEAD_COPY.emailDomain;
  }
  return email;
}

const INN_10_WEIGHTS = [2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_12_FIRST_WEIGHTS = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;
const INN_12_SECOND_WEIGHTS = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8] as const;

function innControlDigit(digits: readonly number[], weights: readonly number[]): number {
  const sum = weights.reduce((total, weight, index) => total + weight * (digits[index] ?? 0), 0);
  return (sum % 11) % 10;
}

/** The control digits of a Russian taxpayer number: 10 digits for a company, 12 for a sole trader. */
export function isValidInn(inn: string): boolean {
  if (!/^(?:\d{10}|\d{12})$/.test(inn)) return false;
  const digits = [...inn].map(Number);
  if (digits.length === 10) return innControlDigit(digits, INN_10_WEIGHTS) === digits[9];
  return (
    innControlDigit(digits, INN_12_FIRST_WEIGHTS) === digits[10] &&
    innControlDigit(digits, INN_12_SECOND_WEIGHTS) === digits[11]
  );
}

export function validateDownloadLead(input: DownloadLeadInput): LeadValidation<DownloadLead> {
  const errors: LeadErrors = {};
  const email = validateEmail(input.email, errors);
  const company = input.company.trim();
  if (company.length === 0) errors.company = LEAD_COPY.companyMissing;
  else if (company.length > COMPANY_MAX_LENGTH) errors.company = LEAD_COPY.companyLong;

  if (Object.keys(errors).length > 0) return { errors, ok: false };
  return { ok: true, value: { company, email } };
}

function isTariffCode(value: string): value is TariffCode {
  return (TARIFF_CODES as readonly string[]).includes(value);
}

export function validateInvoiceLead(input: InvoiceLeadInput): LeadValidation<InvoiceLead> {
  const errors: LeadErrors = {};
  const inn = input.inn.replace(/\s/g, "");
  if (inn.length === 0) errors.inn = LEAD_COPY.innMissing;
  else if (!/^(?:\d{10}|\d{12})$/.test(inn)) errors.inn = LEAD_COPY.innLength;
  else if (!isValidInn(inn)) errors.inn = LEAD_COPY.innChecksum;

  const tariffCode = input.tariffCode.trim();
  if (!isTariffCode(tariffCode)) errors.tariffCode = LEAD_COPY.tariffMissing;

  const email = validateEmail(input.email, errors);

  if (Object.keys(errors).length > 0 || !isTariffCode(tariffCode)) return { errors, ok: false };
  return { ok: true, value: { email, inn, tariffCode } };
}
