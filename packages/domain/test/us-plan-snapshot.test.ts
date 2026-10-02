import { describe, expect, it } from "vitest";
import {
  buildUsPlanSnapshot,
  buildUsPlanDraftFactSources,
  validateUsPlanDraftFactSources,
  canonicalExportDigest,
  changedUsPlanSections,
  usPlanSnapshotDigest,
  type UsPlanConfiguredFacts,
  type UsPlanSections,
} from "../src/index.js";

function description(
  businessName: string,
): UsPlanConfiguredFacts["tlcSourceLocations"][number]["description"] {
  return {
    partyId: "party-1",
    businessName,
    phoneNumber: null,
    addressKind: "street",
    streetAddress: null,
    latitude: null,
    longitude: null,
    city: null,
    stateOrRegion: null,
    zipOrPostalCode: null,
    countryCode: null,
  };
}

function facts(): UsPlanConfiguredFacts {
  return {
    tenantName: "Fictional Foods",
    profileCode: "US_FSMA204_PROCESSOR",
    baselineVersion: "2026-01",
    timeZone: "America/New_York",
    retentionYears: 5,
    tlcSourceLocations: [
      { id: "location-2", description: description("Packing room") },
      { id: "location-1", description: description("Kitchen") },
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
      { id: "location-1", description: description("Kitchen") },
      { id: "location-2", description: description("Packing room") },
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
          { id: "location-2", description: description("New packing room") },
          { id: "location-1", description: description("Kitchen") },
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
      location.description.businessName = "Changed";
      location.description.phoneNumber = "+1 555-0100";
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

describe("US plan draft fact sources", () => {
  it("uses stable IDs for configured items and preserves pending statement ownership", () => {
    const input = facts();
    const manifest = buildUsPlanDraftFactSources(input, sections());
    const reordered = {
      ...input,
      tlcSourceLocations: [...input.tlcSourceLocations].reverse(),
      productProfiles: [...input.productProfiles].reverse(),
    };
    expect(buildUsPlanDraftFactSources(reordered, sections())).toEqual(manifest);
    expect(canonicalExportDigest(buildUsPlanDraftFactSources(reordered, sections()))).toBe(
      canonicalExportDigest(manifest),
    );
    expect(manifest.entries).toContainEqual({
      path: "/configured/tlcSourceLocations/location-1/description/phoneNumber",
      source: { origin: "configured" },
    });
    expect(manifest.entries).toContainEqual({
      path: "/configured/productProfiles/product-2/revision",
      source: { origin: "configured" },
    });
    expect(manifest.entries).toContainEqual({
      path: "/sections/recordMaintenance/narrative/0",
      source: { origin: "operator_pending" },
    });
    expect(manifest.entries).toContainEqual({
      path: "/ftlReviewWorkflow",
      source: { origin: "application_policy", version: 1 },
    });
    expect(
      manifest.entries
        .filter((entry) => entry.path.startsWith("/sections/"))
        .every((entry) => entry.source.origin === "operator_pending"),
    ).toBe(true);
    expect(validateUsPlanDraftFactSources(input, sections(), manifest)).toBeUndefined();
    expect(
      manifest.entries
        .filter((entry) => entry.path.startsWith("/configured/"))
        .every((entry) => entry.source.origin === "configured"),
    ).toBe(true);
    expect(
      manifest.entries
        .filter((entry) => entry.path.startsWith("/configured/tlcSourceLocations/location-1/"))
        .map((entry) => entry.path),
    ).toEqual([
      "/configured/tlcSourceLocations/location-1/description/addressKind",
      "/configured/tlcSourceLocations/location-1/description/businessName",
      "/configured/tlcSourceLocations/location-1/description/city",
      "/configured/tlcSourceLocations/location-1/description/countryCode",
      "/configured/tlcSourceLocations/location-1/description/latitude",
      "/configured/tlcSourceLocations/location-1/description/longitude",
      "/configured/tlcSourceLocations/location-1/description/partyId",
      "/configured/tlcSourceLocations/location-1/description/phoneNumber",
      "/configured/tlcSourceLocations/location-1/description/stateOrRegion",
      "/configured/tlcSourceLocations/location-1/description/streetAddress",
      "/configured/tlcSourceLocations/location-1/description/zipOrPostalCode",
      "/configured/tlcSourceLocations/location-1/id",
    ]);
  });

  it("covers all operator fields, including empty ordered lists and nullable contact", () => {
    const input = sections();
    input.recordMaintenance.narrative = [];
    const paths = buildUsPlanDraftFactSources(facts(), input)
      .entries.filter((entry) => entry.path.startsWith("/sections/"))
      .map((entry) => entry.path);
    expect(paths).toEqual([
      "/sections/farmActivity/explanation",
      "/sections/farmActivity/status",
      "/sections/ftlIdentification/procedure",
      "/sections/ftlIdentification/reviewCadence",
      "/sections/pointOfContact/email",
      "/sections/pointOfContact/name",
      "/sections/pointOfContact/phone",
      "/sections/pointOfContact/title",
      "/sections/recordMaintenance/backupAndRecovery",
      "/sections/recordMaintenance/formats",
      "/sections/recordMaintenance/formats/0",
      "/sections/recordMaintenance/formats/1",
      "/sections/recordMaintenance/narrative",
      "/sections/recordMaintenance/recordLocations",
      "/sections/recordMaintenance/recordLocations/0",
      "/sections/recordMaintenance/recordLocations/1",
      "/sections/recordMaintenance/responsibleRoles",
      "/sections/recordMaintenance/responsibleRoles/0",
      "/sections/recordMaintenance/responsibleRoles/1",
      "/sections/recordMaintenance/systemOfRecord",
      "/sections/reviewAndUpdate/procedure",
      "/sections/tlcAssignment/procedure",
    ]);
  });

  it("rejects missing, duplicate, extra paths and workflow claimed as operator confirmation", () => {
    const manifest = buildUsPlanDraftFactSources(facts(), sections());
    const first = manifest.entries.at(0);
    if (!first) throw new Error("expected manifest entries");
    for (const entries of [
      manifest.entries.slice(1),
      [...manifest.entries, first],
      [...manifest.entries, { path: "/invented", source: { origin: "configured" } }],
      manifest.entries.map((entry) =>
        entry.path === "/ftlReviewWorkflow"
          ? {
              ...entry,
              source: {
                origin: "operator_confirmed",
                actorId: "actor",
                confirmedAt: "2026-10-02T00:00:00.000Z",
              },
            }
          : entry,
      ),
      manifest.entries.map((entry) =>
        entry.path.startsWith("/sections/")
          ? { ...entry, source: { origin: "operator_confirmed" } }
          : entry,
      ),
      manifest.entries.map((entry) =>
        entry.path.startsWith("/sections/")
          ? { ...entry, source: { origin: "synthetic_fixture" } }
          : entry,
      ),
    ]) {
      expect(() =>
        validateUsPlanDraftFactSources(facts(), sections(), { ...manifest, entries }),
      ).toThrow(TypeError);
    }
  });

  it.each(["tlcSourceLocations", "productProfiles"] as const)(
    "rejects duplicate stable IDs in %s",
    (field) => {
      const input = facts();
      if (field === "tlcSourceLocations")
        input.tlcSourceLocations = [...input.tlcSourceLocations, ...input.tlcSourceLocations];
      else input.productProfiles = [...input.productProfiles, ...input.productProfiles];
      expect(() => buildUsPlanDraftFactSources(input, sections())).toThrow("duplicate_fact_id");
    },
  );
});
