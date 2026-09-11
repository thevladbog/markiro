import type { z } from "zod";
import {
  agreementRequisitesSchema,
  agreementSignatorySchema,
  agreementTermsSchema,
} from "@markiro/platform-contracts";

export type AgreementRequisitesInput = z.infer<typeof agreementRequisitesSchema>;
export type AgreementSignatory = z.infer<typeof agreementSignatorySchema>;
export type AgreementTerms = z.infer<typeof agreementTermsSchema>;

export const EMPTY_SIGNATORY: AgreementSignatory = {
  position: null,
  fullName: null,
  authorityBasis: null,
};

export const EMPTY_TERMS: AgreementTerms = {
  disputeVenue: null,
  penaltyRatePercent: null,
  penaltyCapPercent: null,
};

/**
 * The `terms` column stores the negotiated terms together with the
 * signatory. They are one editable group in the panel and one JSONB column
 * here; the API contract still exposes them as two fields.
 */
export const storedTermsSchema = agreementTermsSchema.extend({
  signatory: agreementSignatorySchema,
});
export type StoredTerms = z.infer<typeof storedTermsSchema>;

export const EMPTY_STORED_TERMS: StoredTerms = { ...EMPTY_TERMS, signatory: EMPTY_SIGNATORY };

export function buildStoredTerms(
  terms: AgreementTerms | undefined,
  signatory: AgreementSignatory | undefined,
): StoredTerms {
  return {
    ...(terms ?? EMPTY_TERMS),
    signatory: signatory ?? EMPTY_SIGNATORY,
  };
}

/**
 * The JSONB columns are typed as plain records at the schema level, so every
 * read goes through the contract schema. A row written by an older revision
 * that no longer parses is a defect we want surfaced, not silently rendered.
 */
export function parseRequisites(value: unknown, column: string): AgreementRequisitesInput {
  const result = agreementRequisitesSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Stored agreement ${column} does not match the requisites contract`);
  }
  return result.data;
}

export function parseStoredTerms(value: unknown): StoredTerms {
  const result = storedTermsSchema.safeParse(value);
  return result.success ? result.data : EMPTY_STORED_TERMS;
}

export function parseSignatory(value: unknown): AgreementSignatory {
  return parseStoredTerms(value).signatory;
}

export function parseTerms(value: unknown): AgreementTerms {
  const stored = parseStoredTerms(value);
  return {
    disputeVenue: stored.disputeVenue,
    penaltyRatePercent: stored.penaltyRatePercent,
    penaltyCapPercent: stored.penaltyCapPercent,
  };
}

/**
 * Postgres reports a unique violation as SQLSTATE 23505 and carries the
 * constraint name on the error object, sometimes behind a driver `cause`.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === "23505" && candidate.constraint === constraint) return true;
  return candidate.cause !== undefined && isUniqueViolation(candidate.cause, constraint);
}
