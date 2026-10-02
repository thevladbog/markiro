import { describe, expect, it } from "vitest";
import {
  buildUsPlanSnapshot,
  changedUsPlanSections,
  usPlanSnapshotDigest,
  type UsPlanConfiguredFacts,
  type UsPlanSections,
} from "../src/index.js";

function facts(): UsPlanConfiguredFacts {
  return {
    tenantName: "Fictional Foods",
    profileCode: "US_FSMA204_PROCESSOR",
    baselineVersion: "2026-01",
    timeZone: "America/New_York",
    retentionYears: 5,
    tlcSourceLocations: [
      { id: "location-2", description: "Packing room" },
      { id: "location-1", description: "Kitchen" },
    ],
    productProfiles: [
      { productId: "product-2", revision: 3, coverageStatus: "not_covered" },
      { productId: "product-1", revision: 1, coverageStatus: "covered" },
    ],
  };
}

function sections(): UsPlanSections {
  return {
    recordMaintenance: {
      systemOfRecord: "Markiro",
      formats: ["CSV", "PDF"],
      recordLocations: ["Office", "Archive"],
      responsibleRoles: ["QA", "Manager"],
      backupAndRecovery: "Operator-confirmed procedure",
      narrative: ["First paragraph", "Second paragraph"],
    },
    ftlIdentification: { procedure: "Review individual foods", reviewCadence: "As needed" },
    tlcAssignment: { procedure: "Assign a TLC at processing" },
    pointOfContact: { name: "Fictional Person", title: "QA", phone: "555-0100", email: null },
    farmActivity: { status: "no", explanation: "Processor only" },
    reviewAndUpdate: { procedure: "Review changed practices" },
  };
}

describe("US plan configuration snapshot", () => {
  it("captures the current code-owned manual FTL review workflow", () => {
    const snapshot = buildUsPlanSnapshot(facts(), sections(), "operational");
    expect(snapshot.ftlReviewWorkflow).toEqual({
      version: 1,
      reviewMode: "manual",
      coverageStatuses: [
        "covered",
        "contains_ftl_same_form",
        "not_covered",
        "unknown",
        "exemption_review_required",
      ],
      positiveCoverageStatuses: ["covered", "contains_ftl_same_form"],
      positiveCoverageEvidenceFields: [
        "coverageRationale",
        "ftlCategory",
        "ftlSourceUrl",
        "ftlSourceVersion",
      ],
      coverageChangeAuthority: "traceability.qa.manage",
      reviewerAttribution: "server_actor_on_coverage_change",
      reviewTimeAttribution: "server_time_on_coverage_change",
      reviewCadenceSource: "operator_narrative",
      automaticLegalDetermination: false,
    });
  });

  it("ignores workflow descriptors supplied through arbitrary configured facts", () => {
    const input = {
      ...facts(),
      ftlReviewWorkflow: { version: 99, reviewMode: "automatic" },
    };
    const snapshot = buildUsPlanSnapshot(input, sections(), "operational");
    expect(snapshot.ftlReviewWorkflow.version).toBe(1);
    expect(snapshot.ftlReviewWorkflow.reviewMode).toBe("manual");
  });

  it("detects an older frozen workflow version without rewriting it", () => {
    const current = buildUsPlanSnapshot(facts(), sections(), "operational");
    const older = {
      ...current,
      ftlReviewWorkflow: { ...current.ftlReviewWorkflow, version: 0 },
    };
    const before = JSON.stringify(older);
    expect(usPlanSnapshotDigest(older)).not.toBe(usPlanSnapshotDigest(current));
    expect(changedUsPlanSections(older, facts())).toEqual(["ftlIdentification"]);
    expect(JSON.stringify(older)).toBe(before);
  });

  it("detects changed frozen workflow evidence even with the same version", () => {
    const current = buildUsPlanSnapshot(facts(), sections(), "operational");
    const older = {
      ...current,
      ftlReviewWorkflow: { ...current.ftlReviewWorkflow, positiveCoverageEvidenceFields: [] },
    };
    expect(usPlanSnapshotDigest(older)).not.toBe(usPlanSnapshotDigest(current));
    expect(changedUsPlanSections(older, facts())).toEqual(["ftlIdentification"]);
  });

  it("detaches workflow arrays between snapshots and from future policy captures", () => {
    const first = buildUsPlanSnapshot(facts(), sections(), "operational");
    const second = buildUsPlanSnapshot(facts(), sections(), "operational");
    const before = usPlanSnapshotDigest(first);
    second.ftlReviewWorkflow.coverageStatuses.pop();
    second.ftlReviewWorkflow.positiveCoverageStatuses.pop();
    second.ftlReviewWorkflow.positiveCoverageEvidenceFields.pop();
    expect(usPlanSnapshotDigest(first)).toBe(before);
    expect(usPlanSnapshotDigest(buildUsPlanSnapshot(facts(), sections(), "operational"))).toBe(
      before,
    );
    expect(changedUsPlanSections(first, facts())).toEqual([]);
    expect(changedUsPlanSections(second, facts())).toEqual(["ftlIdentification"]);
  });

  it("normalizes unordered facts without changing input or reporting changes", () => {
    const input = facts();
    const before = structuredClone(input);
    const current = {
      ...input,
      tlcSourceLocations: [...input.tlcSourceLocations].reverse(),
      productProfiles: [...input.productProfiles].reverse(),
    };
    const a = buildUsPlanSnapshot(input, sections(), "trusted_synthetic");
    const b = buildUsPlanSnapshot(current, sections(), "trusted_synthetic");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(usPlanSnapshotDigest(a)).toBe(usPlanSnapshotDigest(b));
    expect(changedUsPlanSections(a, current)).toEqual([]);
    expect(input).toEqual(before);
    expect(a.configured.tlcSourceLocations).toEqual([
      { id: "location-1", description: "Kitchen" },
      { id: "location-2", description: "Packing room" },
    ]);
  });

  it.each([
    ["tenant name", { tenantName: "Renamed Foods" }, ["recordMaintenance"]],
    ["timezone", { timeZone: "America/Chicago" }, ["recordMaintenance"]],
    ["retention", { retentionYears: 6 }, ["recordMaintenance"]],
    ["baseline", { baselineVersion: "2026-02" }, ["ftlIdentification"]],
    [
      "product revision",
      {
        productProfiles: [
          { productId: "product-2", revision: 4, coverageStatus: "not_covered" },
          { productId: "product-1", revision: 1, coverageStatus: "covered" },
        ],
      },
      ["ftlIdentification"],
    ],
    [
      "product coverage",
      {
        productProfiles: [
          { productId: "product-2", revision: 3, coverageStatus: "covered" },
          { productId: "product-1", revision: 1, coverageStatus: "covered" },
        ],
      },
      ["ftlIdentification"],
    ],
    [
      "location description",
      {
        tlcSourceLocations: [
          { id: "location-2", description: "New packing room" },
          { id: "location-1", description: "Kitchen" },
        ],
      },
      ["tlcAssignment"],
    ],
    ["location removal", { tlcSourceLocations: [] }, ["tlcAssignment"]],
    ["product removal", { productProfiles: [] }, ["ftlIdentification"]],
  ] satisfies [string, Partial<UsPlanConfiguredFacts>, (keyof UsPlanSections)[]][])(
    "detects %s with exact section impact",
    (_name, update, expected) => {
      const original = facts();
      const current = { ...original, ...update };
      const effective = buildUsPlanSnapshot(original, sections(), "operational");
      expect(
        usPlanSnapshotDigest(buildUsPlanSnapshot(current, sections(), "operational")),
      ).not.toBe(usPlanSnapshotDigest(effective));
      expect(changedUsPlanSections(effective, current)).toEqual(expected);
    },
  );

  it("returns combined impacts once in stable section order", () => {
    const effective = buildUsPlanSnapshot(facts(), sections(), "operational");
    expect(
      changedUsPlanSections(effective, {
        ...facts(),
        retentionYears: 7,
        timeZone: "America/Chicago",
        baselineVersion: "new",
        productProfiles: [],
        tlcSourceLocations: [],
      }),
    ).toEqual(["recordMaintenance", "ftlIdentification", "tlcAssignment"]);
  });

  it("preserves user text bytes and meaningful narrative order", () => {
    const input = sections();
    input.recordMaintenance.narrative = ["  First é  ", "Second e\u0301"];
    const a = buildUsPlanSnapshot(facts(), input, "operational");
    const reordered = sections();
    reordered.recordMaintenance.narrative = [...input.recordMaintenance.narrative].reverse();
    const b = buildUsPlanSnapshot(facts(), reordered, "operational");
    expect(a.sections).toEqual(input);
    expect(usPlanSnapshotDigest(a)).not.toBe(usPlanSnapshotDigest(b));
  });

  it("copies all mutable facts and sections so later caller edits do not rewrite history", () => {
    const inputFacts = facts();
    const inputSections = sections();
    const snapshot = buildUsPlanSnapshot(inputFacts, inputSections, "trusted_synthetic");
    const originalBytes = JSON.stringify(snapshot);
    const originalDigest = usPlanSnapshotDigest(snapshot);
    inputFacts.tlcSourceLocations.forEach((location) => {
      location.description = "Changed";
    });
    inputFacts.productProfiles.forEach((product) => {
      product.revision = 99;
    });
    inputSections.recordMaintenance.formats.push("Changed");
    inputSections.recordMaintenance.recordLocations.push("Changed");
    inputSections.recordMaintenance.responsibleRoles.push("Changed");
    inputSections.recordMaintenance.narrative.push("Changed");
    inputSections.ftlIdentification.procedure = "Changed";
    inputSections.tlcAssignment.procedure = "Changed";
    inputSections.pointOfContact.name = "Changed";
    inputSections.farmActivity.explanation = "Changed";
    inputSections.reviewAndUpdate.procedure = "Changed";
    expect(JSON.stringify(snapshot)).toBe(originalBytes);
    expect(usPlanSnapshotDigest(snapshot)).toBe(originalDigest);
    expect(snapshot.provenance).toBe("trusted_synthetic");
  });

  it("includes trusted provenance in the digest", () => {
    const synthetic = buildUsPlanSnapshot(facts(), sections(), "trusted_synthetic");
    const operational = buildUsPlanSnapshot(facts(), sections(), "operational");
    expect(usPlanSnapshotDigest(synthetic)).not.toBe(usPlanSnapshotDigest(operational));
  });

  it.each([NaN, Infinity, -Infinity])("rejects non-JSON configured numbers: %s", (value) => {
    const snapshot = buildUsPlanSnapshot(
      { ...facts(), retentionYears: value },
      sections(),
      "operational",
    );
    expect(() => usPlanSnapshotDigest(snapshot)).toThrow(TypeError);
  });
});
