/**
 * JSON import: the label model itself, pasted as the same document
 * `POST /label-templates` accepts -- either a bare spec or the request
 * body `{ name, purpose, spec }`. Validation is `parseLabelTemplate`, the
 * exact function the API runs, so the editor and the API can never disagree
 * about what a template is. What this module adds on top is what a paste
 * needs and an API call does not: the wrapper's `name` for the editor,
 * a `purpose` cross-check, and WARNINGS about properties the lenient schema
 * is about to strip silently (`labelTemplateSpecStrictSchema`).
 */
import type { z } from "zod";

import { DomainError } from "../errors.js";
import type { LabelTemplatePurpose } from "../product-labels/contracts.js";
import {
  assertImportInputLimits,
  MAX_LABEL_CODE_ELEMENTS,
  type LabelImportResult,
  type LabelImportWarning,
} from "./import.js";
import { labelTemplateSpecStrictSchema, parseLabelTemplate } from "./model.js";

export interface ParseLabelJsonOptions {
  /** Purpose of the template being edited; a wrapper's differing `purpose` is a warning. */
  purpose: LabelTemplatePurpose;
}

export interface LabelJsonImportResult extends LabelImportResult {
  /** `name` of a `{ name, purpose, spec }` wrapper: trimmed, cut to the API's limit. */
  name?: string;
}

/** `POST /label-templates` caps `name` at 200 characters (`createLabelTemplateSchema`). */
const MAX_TEMPLATE_NAME_LENGTH = 200;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Dotted path in the form `parseLabelTemplate` reports issues: `elements.3.maxlines`. */
function dottedPath(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join(".");
}

/**
 * One warning per unknown key. Issues nested inside an `invalid_union` carry
 * paths RELATIVE to that union's input (Zod finalizes them when the union
 * fails and later prefixes only the union issue itself), so the union's
 * absolute path is carried down as `prefix`. A barcode's `data` is such a
 * union: `{ literal, foo }` fails both the enum branch and the strict-object
 * branch, and the unknown `foo` lives in the second branch's issues.
 */
function collectUnknownProperties(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  prefix: ReadonlyArray<PropertyKey>,
  warnings: LabelImportWarning[],
): void {
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        const source = dottedPath([...path, key]);
        warnings.push({
          code: "UNKNOWN_PROPERTY",
          line: null,
          source,
          message: `unknown property "${source}" is not part of the label model and will be dropped`,
        });
      }
    } else if (issue.code === "invalid_union") {
      for (const branch of issue.errors) collectUnknownProperties(branch, path, warnings);
    }
  }
}

export function parseLabelJson(
  input: string,
  options: ParseLabelJsonOptions,
): LabelJsonImportResult {
  assertImportInputLimits(input);

  let root: unknown;
  try {
    root = JSON.parse(input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new DomainError("LABEL_CODE_INVALID", `invalid JSON: ${reason}`);
  }
  if (!isPlainObject(root)) {
    throw new DomainError("LABEL_CODE_INVALID", "expected a label template object");
  }

  const warnings: LabelImportWarning[] = [];
  let candidate: Record<string, unknown> = root;
  let name: string | undefined;

  if ("spec" in root) {
    const spec = root["spec"];
    if (!isPlainObject(spec)) {
      throw new DomainError("LABEL_CODE_INVALID", "spec must be an object");
    }
    candidate = spec;
    const wrapperName = root["name"];
    if (typeof wrapperName === "string" && wrapperName.trim() !== "") {
      name = wrapperName.trim().slice(0, MAX_TEMPLATE_NAME_LENGTH);
    }
    const wrapperPurpose = root["purpose"];
    if (typeof wrapperPurpose === "string" && wrapperPurpose !== options.purpose) {
      warnings.push({
        code: "PURPOSE_MISMATCH",
        line: null,
        source: `purpose: ${JSON.stringify(wrapperPurpose)}`,
        message:
          `purpose "${wrapperPurpose}" does not match this template's purpose ` +
          `"${options.purpose}"; the layout is imported as is`,
      });
    }
    // Every other wrapper key (`id`, `enabled`, `chzProductGroupCodes`,
    // timestamps of a GET response) is ignored on purpose: the wrapper is
    // not the layout, and a pasted API response must not produce noise.
  }

  const elements = candidate["elements"];
  if (Array.isArray(elements) && elements.length > MAX_LABEL_CODE_ELEMENTS) {
    throw new DomainError(
      "LABEL_CODE_LIMIT",
      `label code exceeds ${MAX_LABEL_CODE_ELEMENTS} elements`,
    );
  }

  const strict = labelTemplateSpecStrictSchema.safeParse(candidate);
  if (!strict.success) collectUnknownProperties(strict.error.issues, [], warnings);

  const spec = parseLabelTemplate(candidate);
  return {
    spec,
    warnings,
    sourceLineByElementId: {},
    ...(name === undefined ? {} : { name }),
  };
}
