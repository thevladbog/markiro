import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
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

/** Approval-only variants require server-recorded evidence; drafts never emit them. */
export type UsPlanFactSource =
  | { origin: "configured" }
  | { origin: "application_policy"; version: number }
  | { origin: "operator_pending" }
  | { origin: "operator_confirmed"; actorId: string; confirmedAt: string }
  | {
      origin: "synthetic_fixture";
      trustedSeed: { seedId: string; verifiedBy: string; verifiedAt: string };
    };

export interface UsPlanFactSourceManifest {
  schemaVersion: 1;
  entries: { path: string; source: UsPlanFactSource }[];
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Separate from snapshot v1: stable configured IDs, frozen operator list indices,
 * and one explicitly versioned code-policy descriptor. Lists carry a container
 * entry as well, so an empty list still has ownership. No approval is inferred.
 */
export function buildUsPlanDraftFactSources(
  facts: UsPlanConfiguredFacts,
  sections: UsPlanSections,
): UsPlanFactSourceManifest {
  const snapshot = buildUsPlanSnapshot(facts, sections, "operational");
  const entries: UsPlanFactSourceManifest["entries"] = [];
  function walk(value: unknown, path: string, source: UsPlanFactSource): void {
    if (Array.isArray(value)) {
      entries.push({ path, source: { ...source } });
      value.forEach((item: unknown, index: number) => walk(item, `${path}/${index}`, source));
    } else if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) =>
        walk(item, `${path}/${pointerSegment(key)}`, source),
      );
    } else {
      entries.push({ path, source: { ...source } });
    }
  }
  const { tlcSourceLocations, productProfiles, ...scalars } = snapshot.configured;
  walk(scalars, "/configured", { origin: "configured" });
  function itemsById<T>(items: T[], collection: string, idOf: (item: T) => string): void {
    const seen = new Set<string>();
    entries.push({ path: collection, source: { origin: "configured" } });
    for (const item of items) {
      const id = idOf(item);
      if (!id.trim()) throw new TypeError("invalid_fact_id");
      if (seen.has(id)) throw new TypeError("duplicate_fact_id");
      seen.add(id);
      walk(item, `${collection}/${pointerSegment(id)}`, { origin: "configured" });
    }
  }
  itemsById(tlcSourceLocations, "/configured/tlcSourceLocations", (item) => item.id);
  itemsById(productProfiles, "/configured/productProfiles", (item) => item.productId);
  walk(snapshot.sections, "/sections", { origin: "operator_pending" });
  entries.push({
    path: "/ftlReviewWorkflow",
    source: { origin: "application_policy", version: snapshot.ftlReviewWorkflow.version },
  });
  entries.sort((a, b) => compareIds(a.path, b.path));
  return { schemaVersion: 1, entries };
}

/** Strict, exhaustive validation also rejects forged draft confirmation evidence. */
export function validateUsPlanDraftFactSources(
  facts: UsPlanConfiguredFacts,
  sections: UsPlanSections,
  manifest: unknown,
): void {
  const expected = buildUsPlanDraftFactSources(facts, sections);
  if (canonicalExportDigest(manifest) !== canonicalExportDigest(expected)) {
    throw new TypeError("invalid_draft_fact_sources");
  }
}

export type UsPlanConfirmationName =
  "procedures" | "backupAndRecovery" | "contact" | "nonFarmScope";

export interface UsPlanApprovalRequest {
  tenantId: string;
  versionId: string;
  expectedRevision: number;
  confirmations: Record<UsPlanConfirmationName, boolean>;
}

export interface UsPlanApprovedEvidence {
  schemaVersion: 1;
  snapshot: UsPlanSnapshot;
  factSources: UsPlanFactSourceManifest;
  confirmations: Record<
    UsPlanConfirmationName,
    Extract<UsPlanFactSource, { origin: "operator_confirmed" | "synthetic_fixture" }>
  >;
}

export type UsPlanApprovalAuthority = {
  kind: "operational" | "synthetic";
  actorId: string;
  confirmedAt: string;
  confirmations: Record<UsPlanConfirmationName, boolean>;
  trustedSeed?: { seedId: string; verifiedBy: string; verifiedAt: string };
};

/** Called only after the service has authenticated the actor and verified seed identity. */
export function buildUsPlanApprovedEvidence(
  snapshot: UsPlanSnapshot,
  draftSources: UsPlanFactSourceManifest,
  authority: UsPlanApprovalAuthority,
): UsPlanApprovedEvidence {
  validateUsPlanDraftFactSources(snapshot.configured, snapshot.sections, draftSources);
  if (
    !authority.actorId.trim() ||
    new Date(authority.confirmedAt).toISOString() !== authority.confirmedAt
  ) {
    throw new TypeError("invalid_confirmation_identity");
  }
  const trustedSeed = authority.trustedSeed;
  if (authority.kind === "synthetic") {
    if (
      snapshot.provenance !== "trusted_synthetic" ||
      !trustedSeed?.seedId ||
      !trustedSeed.verifiedBy ||
      new Date(trustedSeed.verifiedAt).toISOString() !== trustedSeed.verifiedAt
    ) {
      throw new TypeError("trusted_seed_required");
    }
  } else if (snapshot.provenance !== "operational" || authority.trustedSeed) {
    throw new TypeError("approval_provenance_mismatch");
  }
  const names: UsPlanConfirmationName[] = [
    "procedures",
    "backupAndRecovery",
    "contact",
    "nonFarmScope",
  ];
  if (
    authority.kind === "operational" &&
    names.some((name) => authority.confirmations[name] !== true)
  ) {
    throw new TypeError("plan_confirmation_required");
  }
  const assertion = { actorId: authority.actorId, confirmedAt: authority.confirmedAt };
  const confirmationSource: UsPlanApprovedEvidence["confirmations"][UsPlanConfirmationName] =
    authority.kind === "synthetic" && trustedSeed
      ? { origin: "synthetic_fixture", trustedSeed: { ...trustedSeed } }
      : { origin: "operator_confirmed", ...assertion };
  const factSources: UsPlanFactSourceManifest = {
    schemaVersion: 1,
    entries: draftSources.entries.map(({ path, source }) => ({
      path,
      source:
        source.origin !== "operator_pending"
          ? structuredClone(source)
          : authority.kind === "synthetic" && trustedSeed
            ? { origin: "synthetic_fixture", trustedSeed: { ...trustedSeed } }
            : { origin: "operator_confirmed", ...assertion },
    })),
  };
  const policySource: UsPlanFactSource = {
    origin: "application_policy",
    version: snapshot.ftlReviewWorkflow.version,
  };
  function addPolicyPaths(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => addPolicyPaths(item, `${path}/${index}`));
    } else if (value !== null && typeof value === "object") {
      Object.entries(value).forEach(([key, item]) =>
        addPolicyPaths(item, `${path}/${pointerSegment(key)}`),
      );
    }
    if (path !== "/ftlReviewWorkflow") factSources.entries.push({ path, source: policySource });
  }
  addPolicyPaths(snapshot.ftlReviewWorkflow, "/ftlReviewWorkflow");
  factSources.entries.push({
    path: "/provenance",
    source:
      authority.kind === "synthetic" && trustedSeed
        ? { origin: "synthetic_fixture", trustedSeed: { ...trustedSeed } }
        : { origin: "configured" },
  });
  factSources.entries.sort((a, b) => compareIds(a.path, b.path));
  return {
    schemaVersion: 1,
    snapshot: structuredClone(snapshot),
    factSources,
    confirmations: {
      procedures: structuredClone(confirmationSource),
      backupAndRecovery: structuredClone(confirmationSource),
      contact: structuredClone(confirmationSource),
      nonFarmScope: structuredClone(confirmationSource),
    },
  };
}

/** The raw one-time key is deliberately excluded from this canonical request binding. */
export function usPlanApprovalRequestDigest(request: UsPlanApprovalRequest): string {
  return canonicalExportDigest({
    schemaVersion: 1,
    tenantId: request.tenantId,
    versionId: request.versionId,
    expectedRevision: request.expectedRevision,
    confirmations: {
      procedures: request.confirmations.procedures,
      backupAndRecovery: request.confirmations.backupAndRecovery,
      contact: request.confirmations.contact,
      nonFarmScope: request.confirmations.nonFarmScope,
    },
  });
}

export function usPlanIdempotencyKeyHash(key: string): string {
  return bytesToHex(sha256(utf8ToBytes(key)));
}

export function compareUsPlanIdempotency(
  saved: { tenantId: string; keyHash: string; requestDigest: string } | null,
  request: UsPlanApprovalRequest,
  keyHash: string,
): "absent" | "retry" | "conflict" {
  if (!saved || saved.tenantId !== request.tenantId || saved.keyHash !== keyHash) return "absent";
  return saved.requestDigest === usPlanApprovalRequestDigest(request) ? "retry" : "conflict";
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
