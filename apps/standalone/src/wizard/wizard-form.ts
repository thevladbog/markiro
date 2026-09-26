import { ssccSerialCapacity } from "@markiro/domain";
import { z } from "zod";

import type { BootstrapRequest } from "../host/protocol.js";
import {
  characters,
  issuerPrefix,
  loginRule,
  ORG_HOST_FIELDS,
  orgFieldsSchema,
  passwordRule,
  personNameRule,
  THIRTEEN_DIGITS,
  toOrgInput,
} from "../lib/rules.js";
import { DEFAULT_TIME_ZONE } from "../lib/time-zones.js";

/** Administrator, organization, SSCC starts and lines (stage 1 spec §1), then a review. */
export const WIZARD_STEPS = ["admin", "org", "sscc", "lines", "review"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** At most 20 lines, as on the host. */
export const MAX_LINES = 20;

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

const adminSchema = z.object({
  login: loginRule,
  adminName: personNameRule,
  password: passwordRule,
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
        issues.push({ field: "passwordConfirm", message: "rules.passwordConfirm" });
      }
      return issues;
    }
    case "org":
      return issuesOf(orgFieldsSchema.safeParse(values).error);
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
  return {
    admin: {
      login: values.login.trim(),
      name: values.adminName.trim(),
      password: values.password,
    },
    org: toOrgInput(values),
    sscc: { boxNextSerial: values.boxNextSerial, palletNextSerial: values.palletNextSerial },
    lines: values.lines.map((line) => line.name.trim()),
  };
}

const HOST_FIELDS: Readonly<Record<string, WizardField>> = {
  "admin.login": "login",
  "admin.name": "adminName",
  "admin.password": "password",
  "sscc.boxNextSerial": "boxNextSerial",
  "sscc.palletNextSerial": "palletNextSerial",
  lines: "lines.0.name",
};

/** The wizard field a host `validation_failed` names (`org.gln`, `lines.2`). */
export function fieldFromHost(path: string): WizardField | null {
  const line = /^lines\.(\d+)$/.exec(path);
  if (line) return `lines.${Number(line[1])}.name`;
  if (path.startsWith("org.")) return ORG_HOST_FIELDS[path.slice("org.".length)] ?? null;
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
