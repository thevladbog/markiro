import { hasValidCheckDigit, ssccSerialCapacity } from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest } from "../host/protocol.js";

/** Administrator, organization, SSCC starts and lines (stage 1 spec §1), then a review. */
export const WIZARD_STEPS = ["admin", "org", "sscc", "lines", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** At most 20 lines, as on the host. */
export const MAX_LINES = 20;
export const DEFAULT_TIME_ZONE = "Europe/Moscow";

export interface WizardValues {
  login: string;
  adminName: string;
  password: string;
  passwordConfirm: string;
  orgName: string;
  inn: string;
  gln: string;
  /** Comma-separated in the form; a list in the request. */
  gs1Prefixes: string;
  timeZone: string;
  boxNextSerial: number;
  palletNextSerial: number;
  lines: { name: string }[];
}

const PLAIN_FIELDS = [
  "login",
  "adminName",
  "password",
  "passwordConfirm",
  "orgName",
  "inn",
  "gln",
  "gs1Prefixes",
  "timeZone",
  "boxNextSerial",
  "palletNextSerial",
] as const;

/** A form field that can carry an error. */
export type WizardField = (typeof PLAIN_FIELDS)[number] | `lines.${number}.name`;

export interface FieldIssue {
  field: WizardField;
  /** An i18n key. */
  message: string;
}

export function defaultWizardValues(firstLineName: string): WizardValues {
  return {
    login: "admin",
    adminName: "",
    password: "",
    passwordConfirm: "",
    orgName: "",
    inn: "",
    gln: "",
    gs1Prefixes: "",
    timeZone: DEFAULT_TIME_ZONE,
    boxNextSerial: 1,
    palletNextSerial: 0,
    lines: [{ name: firstLineName }],
  };
}

/** The SSCC issuer prefix the host derives from a GLN: its first 9 digits, as in the cloud. */
export function issuerPrefix(gln: string): string {
  return gln.slice(0, 9);
}

/** Split on commas, semicolons and spaces; repeats collapse. */
export function parsePrefixList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).filter((prefix) => prefix.length > 0))];
}

/** Characters as the host counts them (Unicode scalar values). */
function characters(text: string): number {
  return [...text].length;
}

function isValidPrefixList(text: string): boolean {
  const prefixes = parsePrefixList(text);
  return prefixes.length <= 10 && prefixes.every((prefix) => /^\d{4,12}$/.test(prefix));
}

const THIRTEEN_DIGITS = /^\d{13}$/;

const adminSchema = z.object({
  login: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._-]{3,64}$/, "wizard.errors.login"),
  adminName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 100, "wizard.errors.name"),
  password: z
    .string()
    .refine(
      (password) => characters(password) >= 8 && characters(password) <= 128,
      "wizard.errors.password",
    ),
});

const orgSchema = z.object({
  orgName: z
    .string()
    .trim()
    .refine((name) => characters(name) >= 1 && characters(name) <= 200, "wizard.errors.orgName"),
  inn: z
    .string()
    .trim()
    .regex(/^(\d{10}|\d{12})?$/, "wizard.errors.inn"),
  gln: z
    .string()
    .trim()
    .regex(THIRTEEN_DIGITS, "wizard.errors.gln")
    .refine(
      (gln) => !THIRTEEN_DIGITS.test(gln) || hasValidCheckDigit(gln),
      "wizard.errors.glnCheckDigit",
    ),
  gs1Prefixes: z.string().refine(isValidPrefixList, "wizard.errors.gs1Prefixes"),
  timeZone: z.string().min(1, "wizard.errors.timeZone"),
});

function isPlainField(value: string): value is (typeof PLAIN_FIELDS)[number] {
  return (PLAIN_FIELDS as readonly string[]).includes(value);
}

/** The first issue per field; the schemas above only have plain fields. */
function issuesOf(error: z.ZodError | undefined): FieldIssue[] {
  const issues: FieldIssue[] = [];
  for (const issue of error?.issues ?? []) {
    const field = String(issue.path[0]);
    if (isPlainField(field) && !issues.some((known) => known.field === field)) {
      issues.push({ field, message: issue.message });
    }
  }
  return issues;
}

function ssccIssues(values: WizardValues): FieldIssue[] {
  const gln = values.gln.trim();
  const capacity = THIRTEEN_DIGITS.test(gln) ? ssccSerialCapacity(issuerPrefix(gln)) : null;
  const issues: FieldIssue[] = [];
  const check = (
    field: "boxNextSerial" | "palletNextSerial",
    value: number,
    minimum: number,
    belowMinimum: string,
  ) => {
    if (!Number.isInteger(value)) issues.push({ field, message: "wizard.errors.serial" });
    else if (value < minimum) issues.push({ field, message: belowMinimum });
    else if (capacity !== null && value >= capacity) {
      issues.push({ field, message: "wizard.errors.serialCapacity" });
    }
  };
  check("boxNextSerial", values.boxNextSerial, 1, "wizard.errors.boxSerial");
  check("palletNextSerial", values.palletNextSerial, 0, "wizard.errors.serial");
  return issues;
}

function lineIssues(lines: readonly { name: string }[]): FieldIssue[] {
  if (lines.length === 0 || lines.length > MAX_LINES) {
    return [{ field: "lines.0.name", message: "wizard.errors.lines" }];
  }
  const issues: FieldIssue[] = [];
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const name = line.name.trim();
    const field: WizardField = `lines.${index}.name`;
    if (characters(name) < 1 || characters(name) > 100) {
      issues.push({ field, message: "wizard.errors.lineName" });
      return;
    }
    // The host keys names by their Unicode lower case, as `toLowerCase` does.
    const key = name.toLowerCase();
    if (seen.has(key)) issues.push({ field, message: "wizard.errors.lineDuplicate" });
    seen.add(key);
  });
  return issues;
}

/** Problems that keep the user on `step`; `review` checks every step. */
export function validateStep(step: WizardStep, values: WizardValues): FieldIssue[] {
  switch (step) {
    case "admin": {
      const issues = issuesOf(adminSchema.safeParse(values).error);
      if (values.password !== values.passwordConfirm) {
        issues.push({ field: "passwordConfirm", message: "wizard.errors.passwordConfirm" });
      }
      return issues;
    }
    case "org":
      return issuesOf(orgSchema.safeParse(values).error);
    case "sscc":
      return ssccIssues(values);
    case "lines":
      return lineIssues(values.lines);
    case "review":
      return (["admin", "org", "sscc", "lines"] as const).flatMap((each) =>
        validateStep(each, values),
      );
  }
}

export function toBootstrapRequest(values: WizardValues): BootstrapRequest {
  const inn = values.inn.trim();
  return {
    admin: {
      login: values.login.trim(),
      name: values.adminName.trim(),
      password: values.password,
    },
    org: {
      name: values.orgName.trim(),
      inn: inn === "" ? null : inn,
      gln: values.gln.trim(),
      gs1Prefixes: parsePrefixList(values.gs1Prefixes),
      timeZone: values.timeZone,
    },
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
  };
}

const HOST_FIELDS: Readonly<Record<string, WizardField>> = {
  "admin.login": "login",
  "admin.name": "adminName",
  "admin.password": "password",
  "org.name": "orgName",
  "org.inn": "inn",
  "org.gln": "gln",
  "org.gs1Prefixes": "gs1Prefixes",
  "org.timeZone": "timeZone",
  "sscc.boxNextSerial": "boxNextSerial",
  "sscc.palletNextSerial": "palletNextSerial",
  lines: "lines.0.name",
};

/** The wizard field a host `validation_failed` names (`org.gln`, `lines.2`). */
export function fieldFromHost(path: string): WizardField | null {
  const line = /^lines\.(\d+)$/.exec(path);
  if (line) return `lines.${Number(line[1])}.name`;
  return HOST_FIELDS[path] ?? null;
}

const ORG_FIELDS: ReadonlySet<WizardField> = new Set<WizardField>([
  "orgName",
  "inn",
  "gln",
  "gs1Prefixes",
  "timeZone",
]);

/** The step that shows `field`. */
export function stepOf(field: WizardField): WizardStep {
  if (field.startsWith("lines.")) return "lines";
  if (field === "boxNextSerial" || field === "palletNextSerial") return "sscc";
  if (ORG_FIELDS.has(field)) return "org";
  return "admin";
}
