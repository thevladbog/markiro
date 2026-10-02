import type { UsPlanSections } from "@markiro/domain";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  usPlanApproveBodySchema,
  usPlanDraftSaveBodySchema,
  usPlanSectionsSchema,
  type UsPlanSectionsBody,
} from "../src/index.js";

const sections: UsPlanSections = {
  recordMaintenance: {
    systemOfRecord: "",
    formats: [],
    recordLocations: [],
    responsibleRoles: [],
    backupAndRecovery: "",
    narrative: ["  Unconfirmed draft text  "],
  },
  ftlIdentification: { procedure: "", reviewCadence: "" },
  tlcAssignment: { procedure: "" },
  pointOfContact: { name: "", title: "", phone: "", email: null },
  farmActivity: { status: "unknown", explanation: "" },
  reviewAndUpdate: { procedure: "" },
};
const draft = { expectedRevision: 1, changeSummary: "", sections };
const approval = {
  expectedRevision: 1,
  idempotencyKey: "00000000-0000-4000-8000-000000000001",
  confirmations: {
    procedures: false,
    backupAndRecovery: false,
    contact: false,
    nonFarmScope: false,
  },
};
const authorityFields = ["tenantId", "actorUserId", "provenance", "syntheticDemo", "isDemo"];
const sectionEntries = Object.entries(sections);
const textFields = sectionEntries.flatMap(([section, fields]) =>
  Object.entries(fields)
    .filter(([field, value]) => field !== "status" && !Array.isArray(value))
    .map(([field]) => ({ section, fields, field, label: `${section}.${field}` })),
);
const arrayFields = ["formats", "recordLocations", "responsibleRoles", "narrative"];

describe("US plan request contracts", () => {
  it("accepts incomplete drafts without trimming or turning them into approval validation", () => {
    expect(usPlanDraftSaveBodySchema.parse(draft)).toEqual(draft);
    expect(usPlanApproveBodySchema.parse(approval)).toEqual(approval);
    expectTypeOf<UsPlanSectionsBody>().toEqualTypeOf<UsPlanSections>();
  });

  it.each(authorityFields)("rejects client-controlled %s in both request bodies", (field) => {
    expect(usPlanDraftSaveBodySchema.safeParse({ ...draft, [field]: true }).success).toBe(false);
    expect(usPlanApproveBodySchema.safeParse({ ...approval, [field]: true }).success).toBe(false);
  });

  it("rejects unknown top-level fields and extra section names", () => {
    expect(usPlanDraftSaveBodySchema.safeParse({ ...draft, extra: "unknown" }).success).toBe(false);
    expect(usPlanApproveBodySchema.safeParse({ ...approval, extra: "unknown" }).success).toBe(
      false,
    );
    expect(usPlanSectionsSchema.safeParse({ ...sections, extraSection: {} }).success).toBe(false);
  });

  it.each(sectionEntries)("rejects extras in the %s section", (section, fields) => {
    for (const field of ["extra", ...authorityFields]) {
      expect(
        usPlanDraftSaveBodySchema.safeParse({
          ...draft,
          sections: { ...sections, [section]: { ...fields, [field]: true } },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects extras and missing or nonboolean confirmations", () => {
    for (const field of ["extra", ...authorityFields]) {
      expect(
        usPlanApproveBodySchema.safeParse({
          ...approval,
          confirmations: { ...approval.confirmations, [field]: true },
        }).success,
      ).toBe(false);
    }
    for (const field of Object.keys(approval.confirmations)) {
      for (const value of [undefined, null, "true", 1]) {
        expect(
          usPlanApproveBodySchema.safeParse({
            ...approval,
            confirmations: { ...approval.confirmations, [field]: value },
          }).success,
        ).toBe(false);
      }
    }
  });

  it.each([-1, 0, 1.5, "1", null, undefined, NaN, Infinity])(
    "rejects invalid revision %s in both bodies",
    (expectedRevision) => {
      expect(usPlanDraftSaveBodySchema.safeParse({ ...draft, expectedRevision }).success).toBe(
        false,
      );
      expect(usPlanApproveBodySchema.safeParse({ ...approval, expectedRevision }).success).toBe(
        false,
      );
    },
  );

  it.each(["not-a-uuid", "", "00000000-0000-4000-8000-00000000000z", null, undefined])(
    "rejects malformed or missing UUID operation key %s",
    (idempotencyKey) => {
      expect(usPlanApproveBodySchema.safeParse({ ...approval, idempotencyKey }).success).toBe(
        false,
      );
    },
  );

  it.each(textFields)("bounds $label to 4096 characters", ({ section, fields, field }) => {
    for (const [size, valid] of [
      [4096, true],
      [4097, false],
    ] as const) {
      expect(
        usPlanSectionsSchema.safeParse({
          ...sections,
          [section]: { ...fields, [field]: "x".repeat(size) },
        }).success,
      ).toBe(valid);
    }
  });

  it("bounds change summary without requiring approval-ready content", () => {
    expect(
      usPlanDraftSaveBodySchema.safeParse({ ...draft, changeSummary: "x".repeat(4096) }).success,
    ).toBe(true);
    expect(
      usPlanDraftSaveBodySchema.safeParse({ ...draft, changeSummary: "x".repeat(4097) }).success,
    ).toBe(false);
  });

  it.each(arrayFields)("bounds recordMaintenance.%s entries and entry lengths", (field) => {
    for (const [value, valid] of [
      [Array.from({ length: 50 }, () => "x".repeat(4096)), true],
      [Array.from({ length: 51 }, () => ""), false],
      [["x".repeat(4097)], false],
      [[{}], false],
    ] as const) {
      expect(
        usPlanSectionsSchema.safeParse({
          ...sections,
          recordMaintenance: { ...sections.recordMaintenance, [field]: value },
        }).success,
      ).toBe(valid);
    }
  });

  it("accepts the exact farm declaration alternatives and requires every section", () => {
    for (const status of ["no", "yes", "unknown"])
      expect(
        usPlanSectionsSchema.safeParse({ ...sections, farmActivity: { status, explanation: "" } })
          .success,
      ).toBe(true);
    expect(
      usPlanSectionsSchema.safeParse({
        ...sections,
        farmActivity: { status: "maybe", explanation: "" },
      }).success,
    ).toBe(false);
    for (const [section] of sectionEntries)
      expect(usPlanSectionsSchema.safeParse({ ...sections, [section]: undefined }).success).toBe(
        false,
      );
  });
});
