import { z } from "zod";
import { DomainError } from "../../errors.js";
import { parseTraceabilityProfile } from "../profile.js";
import { isTraceabilityReferenceHost } from "../reference-host.js";

export const COVERAGE_STATUSES = Object.freeze([
  "covered",
  "contains_ftl_same_form",
  "not_covered",
  "unknown",
  "exemption_review_required",
] as const);
export type CoverageStatus = (typeof COVERAGE_STATUSES)[number];
export interface CoverageReviewInput {
  coverageStatus: CoverageStatus;
  coverageRationale: string | null;
  ftlCategory: string | null;
  ftlSourceUrl: string | null;
  ftlSourceVersion: string | null;
}
export interface CoverageReviewRecord extends CoverageReviewInput {
  reviewedBy: string | null;
  reviewedAt: string | null;
}
export type CoverageReviewIssue = {
  field: keyof CoverageReviewRecord;
  code: "required" | "format" | "not_assessed" | "unresolved";
};

const reviewTimestamp = z.iso.datetime({ offset: true });
const fieldLimits = {
  coverageRationale: 2000,
  ftlCategory: 200,
  ftlSourceUrl: 2048,
  ftlSourceVersion: 128,
} as const;
const fields = ["coverageRationale", "ftlCategory", "ftlSourceUrl", "ftlSourceVersion"] as const;

function usProfile(context: unknown) {
  const profile = parseTraceabilityProfile(context);
  if (profile === "RU_CHZ")
    throw new DomainError("traceability_profile_required", "A US profile is required.");
  return profile;
}

function validSource(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 32 || (code >= 127 && code <= 159)) return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      isTraceabilityReferenceHost(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Manual-review data policy only. The service must separately enforce fresh QA permissions. */
export function validateCoverageReview(
  input: CoverageReviewInput,
  context: unknown,
): CoverageReviewIssue[] {
  const profile = usProfile(context);
  const issues: CoverageReviewIssue[] = [];
  if (!COVERAGE_STATUSES.includes(input.coverageStatus))
    issues.push({ field: "coverageStatus", code: "format" });
  if (profile === "US_GENERIC_LOT_TRACEABILITY") {
    if (input.coverageStatus !== "unknown")
      issues.push({ field: "coverageStatus", code: "not_assessed" });
    for (const field of fields)
      if (input[field] !== null) issues.push({ field, code: "not_assessed" });
    return issues;
  }
  for (const field of fields) {
    const value = input[field];
    if (value !== null && (!value.trim() || value.trim().length > fieldLimits[field]))
      issues.push({ field, code: "format" });
  }
  if (input.ftlSourceUrl !== null && !validSource(input.ftlSourceUrl))
    issues.push({ field: "ftlSourceUrl", code: "format" });
  if (input.coverageStatus !== "unknown" && input.coverageRationale === null)
    issues.push({ field: "coverageRationale", code: "required" });
  if (input.coverageStatus === "covered" || input.coverageStatus === "contains_ftl_same_form") {
    for (const field of ["ftlCategory", "ftlSourceUrl", "ftlSourceVersion"] as const)
      if (input[field] === null) issues.push({ field, code: "required" });
  }
  return issues;
}

/** A coverage prerequisite, never a verdict that a food or a package complies with a rule. */
export function assessCoverageReview(
  input: CoverageReviewRecord,
  context: unknown,
): {
  state: "reviewed" | "blocked" | "not_assessed";
  issues: CoverageReviewIssue[];
} {
  const issues = validateCoverageReview(input, context);
  if (usProfile(context) === "US_GENERIC_LOT_TRACEABILITY")
    return { state: "not_assessed", issues };
  if (input.coverageStatus === "unknown" || input.coverageStatus === "exemption_review_required")
    issues.push({ field: "coverageStatus", code: "unresolved" });
  if (input.coverageStatus !== "unknown") {
    if (input.reviewedBy === null) issues.push({ field: "reviewedBy", code: "required" });
    if (input.reviewedAt === null) issues.push({ field: "reviewedAt", code: "required" });
  }
  if (input.reviewedBy !== null && (!input.reviewedBy.trim() || input.reviewedBy.length > 128))
    issues.push({ field: "reviewedBy", code: "format" });
  if (input.reviewedAt !== null && !reviewTimestamp.safeParse(input.reviewedAt).success)
    issues.push({ field: "reviewedAt", code: "format" });
  return { state: issues.length ? "blocked" : "reviewed", issues };
}
