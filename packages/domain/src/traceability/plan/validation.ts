import type { UsPlanApprovalInput, UsPlanValidationIssue } from "./model.js";

// Fixed wording guard from docs/us/limitations.md, including the wording that
// requires a separate scope-specific decision. This is not legal assessment.
const prohibitedClaims = [
  "fda approved",
  "fda certified",
  "official fda integration",
  "guarantees compliance",
  "fda requires serialization",
  "fda requires sscc",
  "epcis is required by fda",
  "compliance ready",
].map((claim) => new RegExp(`\\b${claim}\\b`, "gu"));

function hasProhibitedClaim(text: string): boolean {
  // Normalize only a temporary matching copy. Stored/user text is never rewritten.
  const normalized = text.toLowerCase().replace(/[-\u2010-\u2015\s]+/gu, " ");
  return prohibitedClaims.some((claim) => {
    for (const match of normalized.matchAll(claim)) {
      const prefix = normalized.slice(0, match.index);
      // Only an immediately preceding 'not' or 'no' is a simple disclaimer.
      // Do not infer clause-wide scope; repeated negation is not exempted.
      const negated = /\b(?:not|no) $/u.test(prefix);
      const repeatedNegation = /\b(?:not|no) (?:not|no) $/u.test(prefix);
      if (!negated || repeatedNegation) return true;
    }
    return false;
  });
}

/** Pure approval rules over typed input; does not attest storage or authorization. */
export function validateUsPlanApproval(input: UsPlanApprovalInput): UsPlanValidationIssue[] {
  const issues: UsPlanValidationIssue[] = [];
  const issue = (code: string, section: UsPlanValidationIssue["section"], path: string) => {
    issues.push({ code, section, path });
  };
  const required = (text: string, section: UsPlanValidationIssue["section"], path: string) => {
    if (!text.trim()) issue("required_field", section, path);
  };
  const { sections } = input;

  if (input.profileCode !== "US_FSMA204_PROCESSOR") {
    issue("unsupported_profile", "plan", "profileCode");
  }
  if (input.versionNumber > 1 && !input.changeSummary.trim()) {
    issue("change_summary_required", "plan", "changeSummary");
  }
  if (input.tlcSourceLocationCount < 1) {
    issue("tlc_source_location_required", "tlcAssignment", "tlcSourceLocationCount");
  }
  if (sections.farmActivity.status !== "no") {
    issue("farm_scope_unsupported", "farmActivity", "farmActivity.status");
  }

  required(
    sections.recordMaintenance.systemOfRecord,
    "recordMaintenance",
    "recordMaintenance.systemOfRecord",
  );
  required(
    sections.recordMaintenance.backupAndRecovery,
    "recordMaintenance",
    "recordMaintenance.backupAndRecovery",
  );
  for (const field of ["formats", "recordLocations", "responsibleRoles"] as const) {
    const values = sections.recordMaintenance[field];
    const path = `recordMaintenance.${field}`;
    if (values.length === 0) issue("required_field", "recordMaintenance", path);
    values.forEach((value, index) => required(value, "recordMaintenance", `${path}.${index}`));
  }
  required(
    sections.ftlIdentification.procedure,
    "ftlIdentification",
    "ftlIdentification.procedure",
  );
  required(
    sections.ftlIdentification.reviewCadence,
    "ftlIdentification",
    "ftlIdentification.reviewCadence",
  );
  required(sections.tlcAssignment.procedure, "tlcAssignment", "tlcAssignment.procedure");
  for (const field of ["name", "title", "phone"] as const) {
    required(sections.pointOfContact[field], "pointOfContact", `pointOfContact.${field}`);
  }
  required(sections.reviewAndUpdate.procedure, "reviewAndUpdate", "reviewAndUpdate.procedure");

  if (input.provenance !== "trusted_synthetic") {
    const confirmations = [
      ["procedures", "plan"],
      ["backupAndRecovery", "recordMaintenance"],
      ["contact", "pointOfContact"],
      ["nonFarmScope", "farmActivity"],
    ] as const;
    for (const [confirmation, section] of confirmations) {
      if (!input.confirmations[confirmation]) {
        issue("confirmation_required", section, `confirmations.${confirmation}`);
      }
    }
  }

  const scan = (text: string, section: UsPlanValidationIssue["section"], path: string) => {
    if (hasProhibitedClaim(text)) {
      issue("prohibited_claim", section, path);
    }
  };
  scan(input.changeSummary, "plan", "changeSummary");
  for (const section of [
    "recordMaintenance",
    "ftlIdentification",
    "tlcAssignment",
    "pointOfContact",
    "farmActivity",
    "reviewAndUpdate",
  ] as const) {
    for (const [field, value] of Object.entries(sections[section])) {
      const path = `${section}.${field}`;
      if (typeof value === "string") scan(value, section, path);
      else if (Array.isArray(value)) {
        value.forEach((text: string, index: number) => scan(text, section, `${path}.${index}`));
      }
    }
  }

  // Code-point order is independent of the caller's locale and object key order.
  return issues.sort((left, right) => {
    for (const key of ["section", "path", "code"] as const) {
      if (left[key] < right[key]) return -1;
      if (left[key] > right[key]) return 1;
    }
    return 0;
  });
}
