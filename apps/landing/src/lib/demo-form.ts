import type { Locale } from "../content/pages";

export interface DemoLeadInput {
  readonly company: string;
  readonly email: string;
  readonly name: string;
  readonly phone: string;
}

export interface DemoLead {
  readonly company: string;
  readonly email: string;
  readonly name: string;
  readonly phone?: string;
}

type DemoField = keyof DemoLeadInput;
type DemoErrors = Partial<Record<DemoField, string>>;

export type DemoLeadValidation =
  | { readonly ok: true; readonly value: DemoLead }
  | { readonly errors: DemoErrors; readonly ok: false };

const EMAIL_MAX_LENGTH = 254;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const PHONE_INPUT_MAX_LENGTH = 30;
const PHONE_PUNCTUATION = /^\+?[\d\s().-]+$/;

function normalizePhone(value: string, locale: Locale): string | undefined | null {
  if (value.length === 0) return undefined;
  if (value.length > PHONE_INPUT_MAX_LENGTH || !PHONE_PUNCTUATION.test(value)) return null;

  const digits = value.replace(/\D/g, "");
  if (locale === "ru") {
    if (digits.length !== 11) return null;
    if (value.startsWith("8") && digits.startsWith("8")) return `+7${digits.slice(1)}`;
    if (value.startsWith("+7") && digits.startsWith("7")) return `+${digits}`;
    return null;
  }

  if (!value.startsWith("+") || digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

const VALIDATION_COPY = {
  en: {
    companyLong: "Company name must be shorter than 121 characters",
    companyMissing: "Enter your company",
    emailInvalid: "Enter a valid email address",
    emailLong: "Email must be shorter than 255 characters",
    emailMissing: "Enter your email address",
    nameLong: "Name must be shorter than 81 characters",
    nameMissing: "Enter your name",
    phoneInvalid: "Enter a valid international phone number",
  },
  ru: {
    companyLong: "Название компании должно быть короче 121 символа",
    companyMissing: "Укажите компанию",
    emailInvalid: "Укажите корректный email",
    emailLong: "Email должен быть короче 255 символов",
    emailMissing: "Укажите email",
    nameLong: "Имя должно быть короче 81 символа",
    nameMissing: "Укажите имя",
    phoneInvalid: "Проверьте российский номер телефона",
  },
} as const;

export function validateDemoLead(input: DemoLeadInput, locale: Locale = "ru"): DemoLeadValidation {
  const name = input.name.trim();
  const company = input.company.trim();
  const email = input.email.trim().toLowerCase();
  const phoneSource = input.phone.trim();
  const errors: DemoErrors = {};
  const copy = VALIDATION_COPY[locale];

  if (name.length === 0) errors.name = copy.nameMissing;
  else if (name.length > 80) errors.name = copy.nameLong;

  if (company.length === 0) errors.company = copy.companyMissing;
  else if (company.length > 120) errors.company = copy.companyLong;

  if (email.length === 0) errors.email = copy.emailMissing;
  else if (email.length > EMAIL_MAX_LENGTH) errors.email = copy.emailLong;
  else if (!EMAIL_PATTERN.test(email)) errors.email = copy.emailInvalid;

  const phone = normalizePhone(phoneSource, locale);
  if (phone === null) errors.phone = copy.phoneInvalid;

  if (Object.keys(errors).length > 0 || phone === null) return { errors, ok: false };

  return {
    ok: true,
    value: { company, email, name, ...(phone === undefined ? {} : { phone }) },
  };
}
