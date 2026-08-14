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

export function validateDemoLead(input: DemoLeadInput): DemoLeadValidation {
  const name = input.name.trim();
  const company = input.company.trim();
  const phoneSource = input.phone.trim();
  const errors: DemoErrors = {};

  if (name.length === 0) errors.name = "Укажите имя";
  else if (name.length > 80) errors.name = "Имя должно быть короче 81 символа";

  if (company.length === 0) errors.company = "Укажите компанию";
  else if (company.length > 120) {
    errors.company = "Название компании должно быть короче 121 символа";
  }

  const phone = normalizedRussianPhone(phoneSource);
  if (phoneSource.length === 0) errors.phone = "Укажите телефон";
  else if (phone === null) errors.phone = "Проверьте российский номер телефона";

  if (Object.keys(errors).length > 0 || phone === null) return { errors, ok: false };

  return {
    ok: true,
    value: { company, name, phone },
  };
}
