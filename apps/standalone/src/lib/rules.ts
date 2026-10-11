import { hasValidCheckDigit, isValidGtin, normalizeToGtin14 } from "@markiro/domain";
import { z } from "zod";

import { hasCyrillic } from "../host/pairing-code.js";
import type { OrgProfileInput } from "../host/protocol.js";
import { isCivilDate } from "./civil-date.js";

// Field rules shared by the first-run wizard and the office pages. They
// mirror the host's own checks (`host/src/validate.rs`), so a form fails
// before the request is sent. Messages are i18n keys under `rules.`.

/** Characters as the host counts them (Unicode scalar values). */
export function characters(text: string): number {
  return [...text].length;
}

/**
 * What no free-text field may hold: a control character (`char::is_control`:
 * the C0 range, DEL and the C1 range) or an unpaired surrogate. A Rust string
 * cannot hold the latter: `JSON.stringify` writes it as an escape, serde_json
 * refuses that, the IPC call fails before the host is reached and the form
 * would blame the connection for a bad name. With the `u` flag a valid
 * surrogate pair, an emoji, is one code point and stays.
 */
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

/** An unpaired surrogate on its own (see `CONTROL_OR_LONE_SURROGATE`). */
const LONE_SURROGATE = /\p{Cs}/u;

/**
 * Free text as the host takes it (`validate::clean_text`, already trimmed
 * here): 1 to `max` characters, counted as the host counts them, with no
 * control character anywhere and no unpaired surrogate. `trim` removes a tab
 * at the edge of a value, in JavaScript and in Rust alike, so only a tab
 * inside survives it; a NUL survives it anywhere, at the edge too (neither
 * language trims it). The host refuses every control character.
 */
export function isPlainText(text: string, max: number): boolean {
  const count = characters(text);
  return count >= 1 && count <= max && !CONTROL_OR_LONE_SURROGATE.test(text);
}

/**
 * Whether `text` can reach the host at all: no unpaired surrogate, which no
 * Rust string holds (see `CONTROL_OR_LONE_SURROGATE`), so the IPC call would
 * fail before the host and the form would blame the connection. Fields that
 * are not free text check it on their own: passwords and the sign-in's login.
 */
export function isTransferable(text: string): boolean {
  return !LONE_SURROGATE.test(text);
}

/**
 * A free-text field of `min` (1 unless given) to `max` characters, counted as
 * the host counts them (`characters`: code points, where zod's own `min` and
 * `max` count UTF-16 units and an emoji twice); the value is trimmed. A wrong
 * length says `message`; a control character or an unpaired surrogate says
 * `rules.controlCharacter`, since a tab pasted from a spreadsheet is invisible
 * and a length message would not explain it.
 */
export function plainTextRule(max: number, message: string, min = 1): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) >= min && characters(text) <= max, message)
    .refine((text) => !CONTROL_OR_LONE_SURROGATE.test(text), "rules.controlCharacter");
}

/**
 * An optional free-text field (`validate::optional_text`): blank is none,
 * otherwise as `plainTextRule`, at most `max` characters. The value is
 * trimmed; `toOptionalText` turns a blank one into `null`.
 */
export function optionalTextRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => characters(text) <= max, message)
    .refine((text) => !CONTROL_OR_LONE_SURROGATE.test(text), "rules.controlCharacter");
}

/** An optional text as the host takes it: trimmed, and `null` when blank. */
export function toOptionalText(text: string): string | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
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
export const personNameRule = plainTextRule(100, "rules.name");

/** A device's name (`validate::device_name`). */
export const deviceNameRule = plainTextRule(100, "rules.name");

/** A production line's name (`validate::line_name`). */
export const lineNameRule = plainTextRule(100, "rules.lineName");

/**
 * An operator's personnel number (`validate::operator_login`): 3 to 12 ASCII
 * digits. Leading zeros are part of it, so it stays text and is never
 * compared as a number.
 */
export const operatorLoginRule = z
  .string()
  .trim()
  .regex(/^[0-9]{3,12}$/, "rules.operatorLogin");

/** An operator's PIN: 4 to 6 ASCII digits. Only its hash leaves the office (`hashPin`). */
export const pinRule = z
  .string()
  .trim()
  .regex(/^[0-9]{4,6}$/, "rules.pin");

/** An operator's role (`validate::operator_role`): at most 120 characters, or none. */
export const operatorRoleRule = optionalTextRule(120, "rules.role");

/** A badge's label (`validate::badge_label`): at most 100 characters, or none. */
export const badgeLabelRule = optionalTextRule(100, "rules.badgeLabel");

/**
 * A badge code as a scanner types it: 1 to 256 characters after trimming, as
 * the cloud takes one (`issueBadgeSchema`), and printable ASCII only. A
 * keyboard-wedge scanner presses keys, so under the Russian layout the code
 * arrives in Cyrillic, while a station types the same badge through its own
 * layout: a Cyrillic code is refused with a hint to switch the layout and is
 * never read by key position, as a typed pairing code is (plan 1c3). Only the
 * code's hash leaves the office (`hashBadge`).
 */
export const badgeCodeRule = z
  .string()
  .trim()
  .refine((code) => !hasCyrillic(code), "rules.badgeCodeLayout")
  .refine((code) => /^[ -~]{1,256}$/.test(code), "rules.badgeCode");

/** The organization's or a counterparty's name (`validate::company`). */
export const companyNameRule = plainTextRule(200, "rules.orgName");

/** An INN: 10 or 12 digits, or empty for none (`validate::company`). */
export const innRule = z
  .string()
  .trim()
  .regex(/^(\d{10}|\d{12})?$/, "rules.inn");

/** A GLN: 13 digits (`validate::company`) with a valid GS1 check digit, which only the forms check. */
export const glnRule = z
  .string()
  .trim()
  .regex(THIRTEEN_DIGITS, "rules.gln")
  .refine((gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln), "rules.glnCheckDigit");

/** GS1 prefixes as one comma-separated string: at most 10 of 4-12 digits (`validate::company`). */
export const gs1PrefixesRule = z.string().refine(isValidPrefixList, "rules.gs1Prefixes");

/** A password (`validate::password`), with no unpaired surrogate (`isTransferable`). */
export const passwordRule = z
  .string()
  .refine((password) => characters(password) >= 8 && characters(password) <= 128, "rules.password")
  .refine(isTransferable, "rules.passwordCharacter");

/** Organization fields as a form holds them; `gs1Prefixes` is one comma-separated string. */
export const orgFieldsSchema = z.object({
  orgName: companyNameRule,
  inn: innRule,
  gln: glnRule,
  gs1Prefixes: gs1PrefixesRule,
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

// --- Products (plan 1e1's `validate.rs`, and the domain's GTIN rule) ---

/**
 * The host's caps (`validate::MAX_BOX_CAPACITY`, `MAX_PALLET_BOX_CAPACITY`):
 * the cloud bounds neither capacity, so these only keep a typing slip out of
 * production.
 */
export const MAX_BOX_CAPACITY = 100_000;
export const MAX_PALLET_BOX_CAPACITY = 10_000;
/** The longest shelf life in days: the cloud's bound, `validate::MAX_SHELF_LIFE_DAYS`. */
export const MAX_SHELF_LIFE_DAYS = 3_650;
/** The longest product name and print name, in characters (`validate::product_name`). */
export const MAX_PRODUCT_NAME = 200;

/**
 * What `normalizeToGtin14` takes before it checks the digit: 8, 12, 13 or 14
 * ASCII digits. The domain throws one `GTIN_INVALID` for a wrong length and a
 * wrong check digit alike, so the rule checks the length itself first and
 * says each in its own words.
 */
const GTIN_DIGITS = /^(?:[0-9]{8}|[0-9]{12,14})$/;

/**
 * A product's GTIN as typed: trimmed, 8, 12, 13 or 14 ASCII digits
 * (`rules.gtin`) with a valid GS1 check digit (`rules.gtinCheckDigit`). The
 * host checks only that 14 digits arrive (`validate::gtin14`); the form sends
 * `toGtin14` of the value.
 */
export const gtinRule = z
  .string()
  .trim()
  .regex(GTIN_DIGITS, "rules.gtin")
  .refine((gtin) => !GTIN_DIGITS.test(gtin) || isValidGtin(gtin), "rules.gtinCheckDigit");

/**
 * The 14 digits a GTIN `gtinRule` accepted is saved as: zero-padded by
 * `normalizeToGtin14`. Throws `DomainError` (`GTIN_INVALID`) for anything
 * `gtinRule` refuses: call it on the rule's output.
 */
export function toGtin14(gtin: string): string {
  return normalizeToGtin14(gtin.trim());
}

/** A product's name (`validate::product_name`): 1 to 200 characters. */
export const productNameRule = plainTextRule(MAX_PRODUCT_NAME, "rules.productName");

/** A product's print name (`validate::print_name`): up to 200 characters, blank for none. */
export const printNameRule = optionalTextRule(MAX_PRODUCT_NAME, "rules.printName");

/** A whole number as typed: ASCII digits with no sign, leading zero, point, comma or exponent. */
const WHOLE_NUMBER = /^[1-9][0-9]*$/;

/**
 * An optional count as typed (`validate::count`): blank for none, otherwise a
 * whole number from 1 to `max`. The text is checked as text before it becomes
 * a number: `Number` takes `1e3`, `0x10` and `12.0`, which the host's integer
 * does not. `toCount` turns an accepted value into the number.
 */
export function countRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => text === "" || (WHOLE_NUMBER.test(text) && Number(text) <= max), message);
}

/**
 * A count the form always sends: a whole number from 1 to `max`, checked as
 * text as `countRule` checks it, never blank. `toCount` of an accepted value
 * is its number.
 */
export function requiredCountRule(max: number, message: string): z.ZodString {
  return z
    .string()
    .trim()
    .refine((text) => WHOLE_NUMBER.test(text) && Number(text) <= max, message);
}

/** An optional count `countRule` accepted, as the host takes it: `null` when blank. */
export function toCount(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === "" ? null : Number(trimmed);
}

/** Units in a box: 1 to `MAX_BOX_CAPACITY`, or none. */
export const boxCapacityRule = countRule(MAX_BOX_CAPACITY, "rules.boxCapacity");

/** Boxes on a pallet: 1 to `MAX_PALLET_BOX_CAPACITY`, or none. */
export const palletBoxCapacityRule = countRule(MAX_PALLET_BOX_CAPACITY, "rules.palletBoxCapacity");

/** A shelf life in days: 1 to `MAX_SHELF_LIFE_DAYS`, or none. */
export const shelfLifeDaysRule = countRule(MAX_SHELF_LIFE_DAYS, "rules.shelfLifeDays");

/**
 * A product group as the form's select holds it: `""` for none, or a group's
 * code. The select offers only the host's groups and the product's own code,
 * and the host refuses a code it does not know (`validation_failed` on
 * `chzProductGroupCode`).
 */
export const productGroupRule = z.string().regex(/^(?:[1-9][0-9]*)?$/, "rules.productGroup");

/** A product group `productGroupRule` accepted, as the host takes it: `null` for none. */
export function toGroupCode(value: string): number | null {
  return value === "" ? null : Number(value);
}

// --- Shifts (plan 2a1's `validate.rs`) ---

/** The largest plan of a shift, in units (`validate::MAX_PLANNED_QTY`). */
export const MAX_PLANNED_QTY = 10_000_000;

/** A shift's plan: 1 to `MAX_PLANNED_QTY` units, or none. */
export const plannedQtyRule = countRule(MAX_PLANNED_QTY, "rules.plannedQty");

/** A shift's box capacity: 1 to `MAX_BOX_CAPACITY` units, always sent. */
export const shiftBoxCapacityRule = requiredCountRule(MAX_BOX_CAPACITY, "rules.shiftBoxCapacity");

/** The boxes on a pallet of a shift with pallets: 1 to `MAX_PALLET_BOX_CAPACITY`, always sent. */
export const shiftPalletBoxCapacityRule = requiredCountRule(
  MAX_PALLET_BOX_CAPACITY,
  "rules.shiftPalletBoxCapacity",
);

/** A production date: a civil date the host takes (`validate::civil_date`). */
export const productionDateRule = z.string().refine(isCivilDate, "rules.productionDate");

/** The shortest and the longest reason the office gives for closing a shift. */
export const MIN_CLOSE_REASON = 3;
export const MAX_CLOSE_REASON = 500;

/**
 * The office's reason for closing a shift (`validate::close_reason`): trimmed,
 * 3 to 500 characters counted as the host counts them, with no control
 * character and no unpaired surrogate.
 */
export const closeReasonRule = plainTextRule(
  MAX_CLOSE_REASON,
  "rules.closeReason",
  MIN_CLOSE_REASON,
);
