import type { schema } from "@markiro/db";
import type { UsPlanSections } from "@markiro/domain";
import { usPlanSectionsSchema } from "@markiro/platform-contracts";
import { ServiceUnavailableException } from "@nestjs/common";

export type UsPlanVersionRow = typeof schema.traceabilityPlanVersions.$inferSelect;

export interface UsPlanDraftView {
  id: string;
  versionNumber: number;
  status: "draft";
  draftRevision: number;
  schemaVersion: 1;
  sections: UsPlanSections;
  changeSummary: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  statementOwnership: "operator_pending";
}

/** Stored JSON is untrusted; this parser grants no authorization or approval. */
export function parseUsPlanDraftRow(row: UsPlanVersionRow): UsPlanDraftView {
  const sections = usPlanSectionsSchema.safeParse(row.sections);
  if (
    !sections.success ||
    row.status !== "draft" ||
    row.schemaVersion !== 1 ||
    !Number.isSafeInteger(row.versionNumber) ||
    row.versionNumber < 1 ||
    !Number.isSafeInteger(row.draftRevision) ||
    row.draftRevision < 1 ||
    !Number.isFinite(row.createdAt.getTime()) ||
    !Number.isFinite(row.updatedAt.getTime()) ||
    row.approvedBy !== null ||
    row.approvedAt !== null ||
    row.configSnapshot !== null ||
    row.configDigest !== null ||
    row.pdfObjectKey !== null ||
    row.pdfSha256 !== null ||
    row.pdfByteSize !== null ||
    row.rendererVersion !== null ||
    row.supersededById !== null ||
    row.supersededAt !== null ||
    row.retainThrough !== null
  ) {
    throw new ServiceUnavailableException({ code: "us_plan_stored_draft_invalid" });
  }
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    status: "draft",
    draftRevision: row.draftRevision,
    schemaVersion: 1,
    sections: sections.data,
    changeSummary: row.changeSummary,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    statementOwnership: "operator_pending",
  };
}
