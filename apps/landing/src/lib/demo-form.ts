export interface DemoLeadInput {
  readonly company: string;
  readonly name: string;
  readonly phone: string;
}

export interface DemoLead {
  readonly company: string;
  readonly name: string;
  readonly phone: `+7${string}`;
}

type DemoField = keyof DemoLeadInput;
type DemoErrors = Partial<Record<DemoField, string>>;

export type DemoLeadValidation =
  | { readonly ok: true; readonly value: DemoLead }
  | { readonly errors: DemoErrors; readonly ok: false };

function normalizedRussianPhone(value: string): `+7${string}` | null {
  const digits = value.replace(/\D/g, "");
  const normalized = digits.startsWith("8") ? `7${digits.slice(1)}` : digits;
  if (normalized.length !== 11 || !normalized.startsWith("7")) return null;
  return `+7${normalized.slice(1)}`;
}

const VALIDATION_COPY = {
  en: {
    companyLong: "Company name must be shorter than 121 characters",
    companyMissing: "Enter your company",
    nameLong: "Name must be shorter than 81 characters",
    nameMissing: "Enter your name",
    phoneInvalid: "Enter a valid Russian phone number",
    phoneMissing: "Enter a phone number",
  },
  ru: {
    companyLong: "Название компании должно быть короче 121 символа",
    companyMissing: "Укажите компанию",
    nameLong: "Имя должно быть короче 81 символа",
    nameMissing: "Укажите имя",
    phoneInvalid: "Проверьте российский номер телефона",
    phoneMissing: "Укажите телефон",
  },
} as const;

export function validateDemoLead(input: DemoLeadInput, locale: Locale = "ru"): DemoLeadValidation {
  const name = input.name.trim();
  const company = input.company.trim();
  const phoneSource = input.phone.trim();
  const errors: DemoErrors = {};
  const copy = VALIDATION_COPY[locale];

  if (name.length === 0) errors.name = copy.nameMissing;
  else if (name.length > 80) errors.name = copy.nameLong;

  if (company.length === 0) errors.company = copy.companyMissing;
  else if (company.length > 120) {
    errors.company = copy.companyLong;
  }

  const phone = normalizedRussianPhone(phoneSource);
  if (phoneSource.length === 0) errors.phone = copy.phoneMissing;
  else if (phone === null) errors.phone = copy.phoneInvalid;

  if (Object.keys(errors).length > 0 || phone === null) return { errors, ok: false };

  return {
    ok: true,
    value: { company, name, phone },
  };
}
import type { Locale } from "../content/pages";
