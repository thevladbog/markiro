import { hasValidCheckDigit } from "@markiro/domain";
import { z } from "zod";

import type { OrgProfileInput } from "../host/protocol.js";

// Field rules shared by the first-run wizard and the office pages. They
// mirror the host's own checks (`host/src/validate.rs`), so a form fails
// before the request is sent. Messages are i18n keys under `rules.`.

/** Characters as the host counts them (Unicode scalar values). */
export function characters(text: string): number {
  return [...text].length;
}

export const THIRTEEN_DIGITS = /^\d{13}$/;

/** The SSCC issuer prefix the host derives from a GLN: its first 9 digits, as in the cloud. */
export function issuerPrefix(gln: string): string {
  return gln.slice(0, 9);
}

/** Split on commas, semicolons and spaces; repeats collapse. */
export function parsePrefixList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((prefix) => prefix.length > 0))];
}

function isValidPrefixList(text: string): boolean {
  const prefixes = parsePrefixList(text);
  return prefixes.length <= 10 && prefixes.every((prefix) => /^\d{4,12}$/.test(prefix));
}

/** An office login (`validate::office_login`). */
export const loginRule = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]{3,64}$/, "rules.login");

/** A person's display name (`validate::person_name`). */
export const personNameRule = z
  .string()
  .trim()
  .refine((name) => characters(name) >= 1 && characters(name) <= 100, "rules.name");

/** A password (`validate::password`). */
export const passwordRule = z
  .string()
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password");

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
  orgName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 200, "rules.orgName"),
  inn: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{12})?$/, "rules.inn"),
  gln: z
    .string()
    .trim()
    .regex(THIRTEEN_DIGITS, "rules.gln")
    .refine((gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln), "rules.glnCheckDigit"),
  gs1Prefixes: z.string().refine(isValidPrefixList, "rules.gs1Prefixes"),
  timeZone: z.string().min(1, "rules.timeZone"),
});
export type OrgFields = z.input<typeof orgFieldsSchema>;

/** The host's organization fields for form values. */
export function toOrgInput(values: OrgFields): OrgProfileInput {
  const inn = values.inn.trim();
  return {
    name: values.orgName.trim(),
    inn: inn === "" ? null : inn,
    gln: values.gln.trim(),
    gs1Prefixes: parsePrefixList(values.gs1Prefixes),
    timeZone: values.timeZone,
  };
}

/**
 * The form field an organization `validation_failed` names. `PUT
 * /v1/office/org` names bare fields (`gln`); the wizard strips its `org.`.
 */
export const ORG_HOST_FIELDS: Readonly<Record<string, keyof OrgFields>> = {
  name: "orgName",
  inn: "inn",
  gln: "gln",
  gs1Prefixes: "gs1Prefixes",
  timeZone: "timeZone",
};
