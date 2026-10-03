import { describe, expect, it } from "vitest";
import { compareUsPlanConfiguredFacts, type UsPlanConfiguredFacts } from "../src/index.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function facts(): UsPlanConfiguredFacts {
  return {
    tenantName: "Fictional Foods",
    profileCode: "US_FSMA204_PROCESSOR",
    baselineVersion: "2026-01",
    timeZone: "America/New_York",
    retentionYears: 5,
    tlcSourceLocations: [2, 1].map((n) => ({
      id: id(n),
      description: {
        partyId: id(10),
        businessName: `Room ${n}`,
        phoneNumber: null,
        addressKind: "street",
        streetAddress: null,
        latitude: null,
        longitude: null,
        city: null,
        stateOrRegion: null,
        zipOrPostalCode: null,
        countryCode: null,
      },
    })),
    productProfiles: [4, 3].map((n) => ({
      productId: id(n),
      revision: 1,
      coverageStatus: "covered",
    })),
  };
}
describe("US plan configured fact impact", () => {
  it("ignores insertion order and object property order without mutating inputs", () => {
    const frozen = facts();
    const current = facts();
    current.tlcSourceLocations.reverse();
    current.tlcSourceLocations = current.tlcSourceLocations.map(
      ({ id: locationId, description: { countryCode, ...description } }) => ({
        description: { countryCode, ...description },
        id: locationId,
      }),
    );
    current.productProfiles.reverse();
    const before = structuredClone({ frozen, current });
    expect(compareUsPlanConfiguredFacts(frozen, current)).toEqual({
      changedSections: [],
      changedLocationIds: [],
      changedProductIds: [],
    });
    expect({ frozen, current }).toEqual(before);
  });
  it("reports a changed location description and removal individually in sorted order", () => {
    const frozen = facts();
    const current = facts();
    current.tlcSourceLocations = current.tlcSourceLocations
      .filter((location) => location.id !== id(1))
      .map((location) => ({
        ...location,
        description: { ...location.description, city: "New York" },
      }));
    expect(compareUsPlanConfiguredFacts(frozen, current)).toEqual({
      changedSections: ["tlcSourceLocations"],
      changedLocationIds: [id(1), id(2)],
      changedProductIds: [],
    });
  });
  it("reports added, removed and changed products even when collection counts match", () => {
    const frozen = facts();
    const current = facts();
    current.productProfiles = [
      { productId: id(5), revision: 1, coverageStatus: "unknown" },
      { productId: id(3), revision: 2, coverageStatus: "not_covered" },
    ];
    expect(compareUsPlanConfiguredFacts(frozen, current)).toEqual({
      changedSections: ["productProfiles"],
      changedLocationIds: [],
      changedProductIds: [id(3), id(4), id(5)],
    });
  });
  it.each(["revision", "coverageStatus"] as const)(
    "detects individual product %s changes",
    (field) => {
      const frozen = facts();
      const current = facts();
      current.productProfiles = current.productProfiles.map((product) =>
        product.productId === id(3)
          ? {
              ...product,
              ...(field === "revision" ? { revision: 2 } : { coverageStatus: "unknown" }),
            }
          : product,
      );
      expect(compareUsPlanConfiguredFacts(frozen, current).changedProductIds).toEqual([id(3)]);
    },
  );
  it.each(["tenantName", "baselineVersion", "timeZone", "retentionYears"] as const)(
    "detects scalar %s changes",
    (field) => {
      const frozen = facts();
      const current = facts();
      if (field === "retentionYears") current.retentionYears = 6;
      else current[field] += " changed";
      expect(compareUsPlanConfiguredFacts(frozen, current)).toEqual({
        changedSections: [field === "tenantName" ? "tenant" : "profile"],
        changedLocationIds: [],
        changedProductIds: [],
      });
    },
  );
  it("uses stable section order and ignores extra runtime fields", () => {
    const frozen = facts();
    const current = {
      ...facts(),
      tenantName: "Changed",
      retentionYears: 6,
      ftlReviewWorkflow: { version: 99 },
    };
    current.tlcSourceLocations = [];
    current.productProfiles = [];
    expect(compareUsPlanConfiguredFacts(frozen, current)).toEqual({
      changedSections: ["tenant", "profile", "tlcSourceLocations", "productProfiles"],
      changedLocationIds: [id(1), id(2)],
      changedProductIds: [id(3), id(4)],
    });
    const withExtraPolicy = { ...facts(), ftlReviewWorkflow: { version: 99 } };
    expect(compareUsPlanConfiguredFacts(facts(), withExtraPolicy).changedSections).toEqual([]);
  });
});
