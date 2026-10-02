import { describe, expect, it } from "vitest";
import {
  buildUsPlanApprovedEvidence,
  buildUsPlanDraftFactSources,
  buildUsPlanSnapshot,
  usPlanApprovalRequestDigest,
  usPlanIdempotencyKeyHash,
  compareUsPlanIdempotency,
  type UsPlanConfiguredFacts,
  type UsPlanSections,
} from "../src/index.js";

const facts: UsPlanConfiguredFacts = {
  tenantName: "Example Processor",
  profileCode: "US_FSMA204_PROCESSOR",
  baselineVersion: "fsma204-v1",
  timeZone: "America/Chicago",
  retentionYears: 5,
  tlcSourceLocations: [],
  productProfiles: [],
};
const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "Paper files",
    formats: ["PDF"],
    recordLocations: ["Office"],
    responsibleRoles: ["QA"],
    backupAndRecovery: "Daily backup",
    narrative: [],
  },
  ftlIdentification: { procedure: "Review", reviewCadence: "As needed" },
  tlcAssignment: { procedure: "Assign" },
  pointOfContact: { name: "A Person", title: "QA", phone: "555-0100", email: null },
  farmActivity: { status: "no", explanation: "No farm activity" },
  reviewAndUpdate: { procedure: "Update" },
};
const confirmations = {
  procedures: true,
  backupAndRecovery: true,
  contact: true,
  nonFarmScope: true,
};
const actor = { actorId: "actor-1", confirmedAt: "2026-10-02T10:00:00.000Z" };

describe("US plan approved evidence", () => {
  it("freezes every path and attributes real assertions to the server actor and time", () => {
    const snapshot = buildUsPlanSnapshot(facts, sections, "operational");
    const draftSources = buildUsPlanDraftFactSources(facts, sections);
    const approved = buildUsPlanApprovedEvidence(snapshot, draftSources, {
      kind: "operational",
      ...actor,
      confirmations,
    });
    expect(approved.schemaVersion).toBe(1);
    expect(approved.snapshot).toEqual(snapshot);
    expect(approved.confirmations).toEqual({
      procedures: { origin: "operator_confirmed", ...actor },
      backupAndRecovery: { origin: "operator_confirmed", ...actor },
      contact: { origin: "operator_confirmed", ...actor },
      nonFarmScope: { origin: "operator_confirmed", ...actor },
    });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/sections/pointOfContact/name")
        ?.source,
    ).toEqual({
      origin: "operator_confirmed",
      ...actor,
    });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/configured/tenantName")?.source,
    ).toEqual({ origin: "configured" });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/ftlReviewWorkflow")?.source,
    ).toEqual({ origin: "application_policy", version: 1 });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/ftlReviewWorkflow/reviewMode")
        ?.source,
    ).toEqual({ origin: "application_policy", version: 1 });
    expect(
      approved.factSources.entries.find(
        (entry) => entry.path === "/ftlReviewWorkflow/coverageStatuses/0",
      )?.source,
    ).toEqual({ origin: "application_policy", version: 1 });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/provenance")?.source,
    ).toEqual({ origin: "configured" });
    expect(
      approved.factSources.entries.some((entry) => entry.source.origin === "operator_pending"),
    ).toBe(false);
  });

  it("rejects unconfirmed real assertions and forged draft provenance", () => {
    const snapshot = buildUsPlanSnapshot(facts, sections, "operational");
    const draftSources = buildUsPlanDraftFactSources(facts, sections);
    expect(() =>
      buildUsPlanApprovedEvidence(snapshot, draftSources, {
        kind: "operational",
        ...actor,
        confirmations: { ...confirmations, contact: false },
      }),
    ).toThrow("plan_confirmation_required");
    const forged = structuredClone(draftSources);
    forged.entries.find((entry) => entry.path === "/sections/pointOfContact/name")!.source = {
      origin: "operator_confirmed",
      ...actor,
    };
    expect(() =>
      buildUsPlanApprovedEvidence(snapshot, forged, {
        kind: "operational",
        ...actor,
        confirmations,
      }),
    ).toThrow("invalid_draft_fact_sources");
  });

  it("uses synthetic provenance only with verified seed evidence", () => {
    const snapshot = buildUsPlanSnapshot(facts, sections, "trusted_synthetic");
    const draftSources = buildUsPlanDraftFactSources(facts, sections);
    expect(() =>
      buildUsPlanApprovedEvidence(snapshot, draftSources, {
        kind: "synthetic",
        ...actor,
        confirmations,
      }),
    ).toThrow("trusted_seed_required");
    const approved = buildUsPlanApprovedEvidence(snapshot, draftSources, {
      kind: "synthetic",
      ...actor,
      confirmations: {
        procedures: false,
        backupAndRecovery: false,
        contact: false,
        nonFarmScope: false,
      },
      trustedSeed: { seedId: "seed-1", verifiedBy: "server", verifiedAt: actor.confirmedAt },
    });
    expect(
      approved.factSources.entries.find((entry) => entry.path === "/sections/pointOfContact/name")
        ?.source,
    ).toEqual({
      origin: "synthetic_fixture",
      trustedSeed: { seedId: "seed-1", verifiedBy: "server", verifiedAt: actor.confirmedAt },
    });
    expect(approved.confirmations.procedures).toEqual({
      origin: "synthetic_fixture",
      trustedSeed: { seedId: "seed-1", verifiedBy: "server", verifiedAt: actor.confirmedAt },
    });
  });
});

it("binds a canonical approval request to tenant, version, revision and assertions", () => {
  const request = {
    tenantId: "tenant-1",
    versionId: "version-1",
    expectedRevision: 2,
    confirmations,
  };
  const digest = usPlanApprovalRequestDigest(request);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(
    usPlanApprovalRequestDigest({
      confirmations,
      expectedRevision: 2,
      versionId: "version-1",
      tenantId: "tenant-1",
    }),
  ).toBe(digest);
  expect(usPlanApprovalRequestDigest({ ...request, tenantId: "tenant-2" })).not.toBe(digest);
  expect(
    usPlanApprovalRequestDigest({
      ...request,
      confirmations: { ...confirmations, contact: false },
    }),
  ).not.toBe(digest);
});

it("hashes the one-time key and distinguishes identical retry from changed request or tenant", () => {
  const keyHash = usPlanIdempotencyKeyHash("00000000-0000-4000-8000-000000000001");
  const request = {
    tenantId: "tenant-1",
    versionId: "version-1",
    expectedRevision: 2,
    confirmations,
  };
  const saved = {
    tenantId: request.tenantId,
    keyHash,
    requestDigest: usPlanApprovalRequestDigest(request),
  };
  expect(keyHash).toMatch(/^[a-f0-9]{64}$/);
  expect(keyHash).toBe("11e594f481958c10e3015d0bf0447a22f068a8a647f475df15ce2c7ab4b8f3f1");
  expect(keyHash).not.toContain("00000000-0000-4000-8000-000000000001");
  expect(compareUsPlanIdempotency(saved, request, keyHash)).toBe("retry");
  expect(compareUsPlanIdempotency(saved, { ...request, expectedRevision: 3 }, keyHash)).toBe(
    "conflict",
  );
  expect(compareUsPlanIdempotency(saved, { ...request, tenantId: "tenant-2" }, keyHash)).toBe(
    "absent",
  );
  expect(
    compareUsPlanIdempotency(
      saved,
      request,
      usPlanIdempotencyKeyHash("00000000-0000-4000-8000-000000000002"),
    ),
  ).toBe("absent");
});
