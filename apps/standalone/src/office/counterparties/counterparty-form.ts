import { z } from "zod";

import type { CounterpartyRecord } from "../../host/protocol.js";
import type { CompanyInput } from "../../host/requests.js";
import {
  companyNameRule,
  glnRule,
  gs1PrefixesRule,
  innRule,
  parsePrefixList,
} from "../../lib/rules.js";

/** A counterparty as the form holds it; `gs1Prefixes` is one comma-separated string. */
export const counterpartyFieldsSchema = z.object({
  name: companyNameRule,
  inn: innRule,
  gln: glnRule,
  gs1Prefixes: gs1PrefixesRule,
  archived: z.boolean(),
});
export type CounterpartyFields = z.input<typeof counterpartyFieldsSchema>;

/** The host names a counterparty's fields as the form does (`validate::company`). */
export const COUNTERPARTY_FIELDS = {
  name: "name",
  inn: "inn",
  gln: "gln",
  gs1Prefixes: "gs1Prefixes",
} as const;

/** The form's values for a counterparty, or empty ones for a new counterparty. */
export function counterpartyFields(counterparty: CounterpartyRecord | null): CounterpartyFields {
  if (counterparty === null) {
    return { name: "", inn: "", gln: "", gs1Prefixes: "", archived: false };
  }
  return {
    name: counterparty.name,
    inn: counterparty.inn ?? "",
    gln: counterparty.gln,
    gs1Prefixes: counterparty.gs1Prefixes.join(", "),
    archived: counterparty.archived,
  };
}

/** The host's company fields for form values: trimmed, an empty INN is none, prefixes a list. */
export function toCompanyInput(values: CounterpartyFields): CompanyInput {
  const inn = values.inn.trim();
  return {
    name: values.name.trim(),
    inn: inn === "" ? null : inn,
    gln: values.gln.trim(),
    gs1Prefixes: parsePrefixList(values.gs1Prefixes),
  };
}
