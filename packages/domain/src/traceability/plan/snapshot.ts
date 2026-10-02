import { canonicalExportDigest } from "../export/canonical.js";
import { US_CAPABILITY } from "../access.js";
import {
  COVERAGE_STATUSES,
  validateCoverageReview,
  type CoverageReviewIssue,
  type CoverageStatus,
} from "../products/coverage.js";
import type { UsPlanSections } from "./model.js";
import type { LocationDescriptionInput } from "../location-description.js";

export interface UsPlanConfiguredFacts {
  tenantName: string;
  profileCode: "US_FSMA204_PROCESSOR";
  baselineVersion: string;
  timeZone: string;
  retentionYears: number;
  tlcSourceLocations: {
    id: string;
    description: LocationDescriptionInput & { partyId: string };
  }[];
  productProfiles: { productId: string; revision: number; coverageStatus: string }[];
}

export interface UsPlanSnapshot {
  schemaVersion: 1;
  configured: UsPlanConfiguredFacts;
  ftlReviewWorkflow: {
    version: number;
    reviewMode: "manual";
    coverageStatuses: CoverageStatus[];
    positiveCoverageStatuses: CoverageStatus[];
    positiveCoverageEvidenceFields: CoverageReviewIssue["field"][];
    coverageChangeAuthority: typeof US_CAPABILITY.QA_MANAGE;
    reviewerAttribution: "server_actor_on_coverage_change";
    reviewTimeAttribution: "server_time_on_coverage_change";
    reviewCadenceSource: "operator_narrative";
    automaticLegalDetermination: false;
  };
  sections: UsPlanSections;
  provenance: "trusted_synthetic" | "operational";
}

/**
 * Version this descriptor when supported workflow semantics change. Evidence comes
 * from the manual domain policy; attribution/authority describe the coverage-change
 * boundary in UsProductProfileStore, not independent verification or a schedule.
 */
function currentFtlReviewWorkflow(): UsPlanSnapshot["ftlReviewWorkflow"] {
  const positiveReviews = COVERAGE_STATUSES.map((coverageStatus) => ({
    coverageStatus,
    issues: validateCoverageReview(
      {
        coverageStatus,
        coverageRationale: null,
        ftlCategory: null,
        ftlSourceUrl: null,
        ftlSourceVersion: null,
      },
      "US_FSMA204_PROCESSOR",
    ),
  })).filter(({ issues }) =>
    issues.some((issue) => issue.field === "ftlCategory" && issue.code === "required"),
  );
  return {
    version: 1,
    reviewMode: "manual",
    coverageStatuses: [...COVERAGE_STATUSES],
    positiveCoverageStatuses: positiveReviews.map(({ coverageStatus }) => coverageStatus),
    positiveCoverageEvidenceFields: [
      ...new Set(
        positiveReviews.flatMap(({ issues }) =>
          issues.filter((issue) => issue.code === "required").map((issue) => issue.field),
        ),
      ),
    ],
    coverageChangeAuthority: US_CAPABILITY.QA_MANAGE,
    reviewerAttribution: "server_actor_on_coverage_change",
    reviewTimeAttribution: "server_time_on_coverage_change",
    reviewCadenceSource: "operator_narrative",
    automaticLegalDetermination: false,
  };
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function configuredFacts(facts: UsPlanConfiguredFacts): UsPlanConfiguredFacts {
  return {
    tenantName: facts.tenantName,
    profileCode: facts.profileCode,
    baselineVersion: facts.baselineVersion,
    timeZone: facts.timeZone,
    retentionYears: facts.retentionYears,
    tlcSourceLocations: facts.tlcSourceLocations
      .map(({ id, description }) => ({
        id,
        description: {
          partyId: description.partyId,
          businessName: description.businessName,
          phoneNumber: description.phoneNumber,
          addressKind: description.addressKind,
          streetAddress: description.streetAddress,
          latitude: description.latitude,
          longitude: description.longitude,
          city: description.city,
          stateOrRegion: description.stateOrRegion,
          zipOrPostalCode: description.zipOrPostalCode,
          countryCode: description.countryCode,
        },
      }))
      .sort((a, b) => compareIds(a.id, b.id)),
    productProfiles: facts.productProfiles
      .map(({ productId, revision, coverageStatus }) => ({ productId, revision, coverageStatus }))
      .sort((a, b) => compareIds(a.productId, b.productId)),
  };
}

/** Capture caller-owned values without retaining mutable references or rewriting text. */
export function buildUsPlanSnapshot(
  facts: UsPlanConfiguredFacts,
  sections: UsPlanSections,
  provenance: UsPlanSnapshot["provenance"],
): UsPlanSnapshot {
  return {
    schemaVersion: 1,
    configured: configuredFacts(facts),
    ftlReviewWorkflow: currentFtlReviewWorkflow(),
    sections: {
      recordMaintenance: {
        systemOfRecord: sections.recordMaintenance.systemOfRecord,
        formats: [...sections.recordMaintenance.formats],
        recordLocations: [...sections.recordMaintenance.recordLocations],
        responsibleRoles: [...sections.recordMaintenance.responsibleRoles],
        backupAndRecovery: sections.recordMaintenance.backupAndRecovery,
        narrative: [...sections.recordMaintenance.narrative],
      },
      ftlIdentification: {
        procedure: sections.ftlIdentification.procedure,
        reviewCadence: sections.ftlIdentification.reviewCadence,
      },
      tlcAssignment: { procedure: sections.tlcAssignment.procedure },
      pointOfContact: {
        name: sections.pointOfContact.name,
        title: sections.pointOfContact.title,
        phone: sections.pointOfContact.phone,
        email: sections.pointOfContact.email,
      },
      farmActivity: {
        status: sections.farmActivity.status,
        explanation: sections.farmActivity.explanation,
      },
      reviewAndUpdate: { procedure: sections.reviewAndUpdate.procedure },
    },
    provenance,
  };
}

export function usPlanSnapshotDigest(snapshot: UsPlanSnapshot): string {
  return canonicalExportDigest(snapshot);
}

/** Only configured facts have live counterparts; operator-owned sections do not. */
export function changedUsPlanSections(
  effective: UsPlanSnapshot,
  current: UsPlanConfiguredFacts,
): (keyof UsPlanSections)[] {
  const before = configuredFacts(effective.configured);
  const after = configuredFacts(current);
  const changed: (keyof UsPlanSections)[] = [];
  if (
    before.tenantName !== after.tenantName ||
    before.timeZone !== after.timeZone ||
    before.retentionYears !== after.retentionYears
  ) {
    changed.push("recordMaintenance");
  }
  if (
    before.profileCode !== after.profileCode ||
    before.baselineVersion !== after.baselineVersion ||
    canonicalExportDigest(effective.ftlReviewWorkflow) !==
      canonicalExportDigest(currentFtlReviewWorkflow()) ||
    canonicalExportDigest(before.productProfiles) !== canonicalExportDigest(after.productProfiles)
  ) {
    changed.push("ftlIdentification");
  }
  if (
    canonicalExportDigest(before.tlcSourceLocations) !==
    canonicalExportDigest(after.tlcSourceLocations)
  ) {
    changed.push("tlcAssignment");
  }
  return changed;
}
