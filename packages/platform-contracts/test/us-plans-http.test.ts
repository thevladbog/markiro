import {
  buildUsPlanSnapshot,
  type UsPlanConfiguredFacts,
  type UsPlanSections,
} from "@markiro/domain";
import { describe, expect, it } from "vitest";
import {
  usPlanValidateBodySchema,
  usPlanDraftCommandResponseSchema,
  usPlanApprovalResponseSchema,
  usPlanPreviewBodySchema,
  usPlanListResponseSchema,
  usPlanDetailResponseSchema,
  usPlanValidationResponseSchema,
  usPlanDraftCreateBodySchema,
  usPlanDraftSaveBodySchema,
  usPlanDraftDiscardBodySchema,
  usPlanApproveBodySchema,
} from "../src/index.js";

const id = "00000000-0000-4000-8000-000000000001";
const time = "2026-10-03T00:00:00.000Z";
it("accepts only safe approval receipts without private artifact or evidence fields", () => {
  const receipt = {
    id,
    versionNumber: 1,
    status: "effective",
    approvedAt: time,
    sha256: "a".repeat(64),
  };
  expect(usPlanApprovalResponseSchema.parse(receipt)).toEqual(receipt);
  for (const field of ["objectKey", "artifact", "evidence", "seed", "tenantId"])
    expect(usPlanApprovalResponseSchema.safeParse({ ...receipt, [field]: "private" }).success).toBe(
      false,
    );
  expect(usPlanApprovalResponseSchema.safeParse({ ...receipt, sha256: "invalid" }).success).toBe(
    false,
  );
});
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
const facts: UsPlanConfiguredFacts = {
  tenantName: "Fictional Foods",
  profileCode: "US_FSMA204_PROCESSOR",
  baselineVersion: "2026-01",
  timeZone: "America/New_York",
  retentionYears: 5,
  tlcSourceLocations: [
    {
      id,
      description: {
        partyId: id,
        businessName: "Kitchen",
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
    },
  ],
  productProfiles: [{ productId: id, revision: 1, coverageStatus: "covered" }],
};
const confirmations = {
  procedures: false,
  backupAndRecovery: false,
  contact: false,
  nonFarmScope: false,
};
const impact = { changedSections: [], changedLocationIds: [], changedProductIds: [] };
const draft = {
  id,
  versionNumber: 1,
  draftRevision: 1,
  status: "draft",
  provenance: "operational",
  createdAt: time,
  updatedAt: time,
};
const artifact = { sha256: "a".repeat(64), byteSize: 123, rendererVersion: "us-plan-pdf-v1" };
it("accepts a committed draft command without inventing independently read provenance", () => {
  const { provenance: _provenance, ...common } = draft;
  expect(_provenance).toBe("operational");
  const command = {
    ...common,
    schemaVersion: 1,
    sections,
    changeSummary: "",
    createdBy: id,
    statementOwnership: "operator_pending",
  };
  expect(usPlanDraftCommandResponseSchema.parse(command)).toEqual(command);
  expect(
    usPlanDraftCommandResponseSchema.safeParse({ ...command, provenance: "trusted_synthetic" })
      .success,
  ).toBe(false);
});
const source = { origin: "operator_confirmed", actorId: id, confirmedAt: time };
const published = {
  id,
  versionNumber: 1,
  status: "effective",
  provenance: "operational",
  createdAt: time,
  updatedAt: time,
  approvedAt: time,
  supersededAt: null,
  retainThrough: null,
  artifact,
};
const detail = {
  ...published,
  schemaVersion: 1,
  createdBy: id,
  approvedBy: id,
  changeSummary: "",
  snapshot: buildUsPlanSnapshot(facts, sections, "operational"),
  factSources: { schemaVersion: 1, entries: [{ path: "/sections", source }] },
  confirmations: {
    procedures: source,
    backupAndRecovery: source,
    contact: source,
    nonFarmScope: source,
  },
  comparisonAgainstCurrentConfiguredFacts: impact,
  retentionIndefiniteReason: null,
};

function extraFieldVariants(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      extraFieldVariants(item).map((variant) =>
        value.map((entry, i) => (i === index ? variant : entry)),
      ),
    );
  }
  if (value === null || typeof value !== "object") return [];
  return [
    { ...value, unexpectedPrivateField: "secret" },
    ...Object.entries(value).flatMap(([key, item]) =>
      extraFieldVariants(item).map((variant) => ({ ...value, [key]: variant })),
    ),
  ];
}

describe("US plan HTTP contracts", () => {
  it("accepts bounded revision bodies and rejects each authority field", () => {
    const validate = { expectedRevision: 1, confirmations };
    expect(usPlanValidateBodySchema.parse(validate)).toEqual(validate);
    expect(usPlanPreviewBodySchema.parse({ expectedRevision: 1 })).toEqual({ expectedRevision: 1 });
    for (const field of [
      "tenantId",
      "actorId",
      "actorUserId",
      "provenance",
      "syntheticDemo",
      "isDemo",
      "approvedAt",
      "objectKey",
    ]) {
      expect(usPlanValidateBodySchema.safeParse({ ...validate, [field]: true }).success).toBe(
        false,
      );
      expect(
        usPlanPreviewBodySchema.safeParse({ expectedRevision: 1, [field]: true }).success,
      ).toBe(false);
      for (const [schema, body] of [
        [usPlanDraftCreateBodySchema, { sections, changeSummary: "" }],
        [usPlanDraftSaveBodySchema, { sections, changeSummary: "", expectedRevision: 1 }],
        [usPlanDraftDiscardBodySchema, { expectedRevision: 1 }],
        [usPlanApproveBodySchema, { expectedRevision: 1, idempotencyKey: id, confirmations }],
      ] as const) {
        expect(schema.safeParse({ ...body, [field]: true }).success).toBe(false);
      }
    }
    for (const expectedRevision of [0, -1, 1.5, "1", null, undefined, NaN, Infinity]) {
      expect(usPlanValidateBodySchema.safeParse({ ...validate, expectedRevision }).success).toBe(
        false,
      );
      expect(usPlanPreviewBodySchema.safeParse({ expectedRevision }).success).toBe(false);
    }
    expect(
      usPlanValidateBodySchema.safeParse({
        ...validate,
        confirmations: { ...confirmations, actorId: id },
      }).success,
    ).toBe(false);
  });
  it("rejects additional fields at every nested published DTO object", () => {
    for (const variant of extraFieldVariants(detail)) {
      expect(usPlanDetailResponseSchema.safeParse(variant).success).toBe(false);
    }
  });
  it("bounds artifact metadata and revision numbers", () => {
    for (const artifactVariant of [
      { ...artifact, sha256: "not-a-digest" },
      { ...artifact, byteSize: 0 },
      { ...artifact, byteSize: 8_000_001 },
      { ...artifact, rendererVersion: "" },
    ]) {
      expect(
        usPlanDetailResponseSchema.safeParse({ ...detail, artifact: artifactVariant }).success,
      ).toBe(false);
    }
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...detail,
        status: "superseded",
        supersededAt: time,
        retainThrough: "2028-10-03",
        retentionIndefiniteReason: null,
      }).success,
    ).toBe(true);
    expect(
      usPlanDetailResponseSchema.safeParse({ ...detail, approvedBy: "not-a-uuid" }).success,
    ).toBe(false);
    expect(
      usPlanValidationResponseSchema.safeParse({
        versionId: id,
        draftRevision: "1",
        issues: [],
        publicationAvailability: "available",
      }).success,
    ).toBe(false);
  });
  it("accepts exact validation issues in supplied sorted order", () => {
    const response = {
      versionId: id,
      draftRevision: 1,
      issues: [
        { section: "plan", path: "profileCode", code: "unsupported_profile" },
        { section: "recordMaintenance", path: "systemOfRecord", code: "required" },
      ],
      publicationAvailability: "artifact_storage_unconfigured",
    };
    expect(usPlanValidationResponseSchema.parse(response)).toEqual(response);
    expect(
      usPlanValidationResponseSchema.safeParse({
        ...response,
        issues: [{ ...response.issues[0], message: "extra" }],
      }).success,
    ).toBe(false);
    expect(
      usPlanValidationResponseSchema.safeParse({
        ...response,
        issues: [{ section: "other", path: "", code: "required" }],
      }).success,
    ).toBe(false);
  });
  it("accepts draft and published list/detail with separate storage availability", () => {
    const list = {
      items: [draft, published],
      effectiveImpact: impact,
      publicationAvailability: "artifact_storage_unconfigured",
    };
    expect(usPlanListResponseSchema.parse(list)).toEqual(list);
    expect(
      usPlanListResponseSchema.parse({ ...list, items: [draft], effectiveImpact: null }),
    ).toEqual({ ...list, items: [draft], effectiveImpact: null });
    const draftDetail = {
      ...draft,
      schemaVersion: 1,
      sections,
      changeSummary: "",
      createdBy: id,
      statementOwnership: "operator_pending",
    };
    expect(usPlanDetailResponseSchema.parse(draftDetail)).toEqual(draftDetail);
    expect(usPlanDetailResponseSchema.parse(detail)).toEqual(detail);
  });
  it("rejects internal storage/idempotency fields and strict nested extras", () => {
    for (const field of ["objectKey", "idempotencyKeyHash", "tenantId"]) {
      expect(usPlanDetailResponseSchema.safeParse({ ...detail, [field]: "secret" }).success).toBe(
        false,
      );
      expect(
        usPlanDetailResponseSchema.safeParse({
          ...detail,
          artifact: { ...artifact, [field]: "secret" },
        }).success,
      ).toBe(false);
      expect(
        usPlanListResponseSchema.safeParse({
          items: [{ ...published, [field]: "secret" }],
          effectiveImpact: impact,
          publicationAvailability: "available",
        }).success,
      ).toBe(false);
    }
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...detail,
        snapshot: { ...detail.snapshot, extra: true },
      }).success,
    ).toBe(false);
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...detail,
        snapshot: {
          ...detail.snapshot,
          configured: {
            ...facts,
            tlcSourceLocations: [
              {
                ...facts.tlcSourceLocations[0],
                description: { ...facts.tlcSourceLocations[0]?.description, secret: true },
              },
            ],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...detail,
        snapshot: {
          ...detail.snapshot,
          ftlReviewWorkflow: {
            ...detail.snapshot.ftlReviewWorkflow,
            automaticLegalDetermination: true,
          },
        },
      }).success,
    ).toBe(false);
  });
  it("accepts sanitized synthetic provenance but rejects seed proof at every source boundary", () => {
    const synthetic = { origin: "synthetic_fixture" };
    const demo = {
      ...detail,
      provenance: "trusted_synthetic",
      snapshot: { ...detail.snapshot, provenance: "trusted_synthetic" },
      factSources: { schemaVersion: 1, entries: [{ path: "/sections", source: synthetic }] },
      confirmations: {
        procedures: synthetic,
        backupAndRecovery: synthetic,
        contact: synthetic,
        nonFarmScope: synthetic,
      },
    };
    expect(usPlanDetailResponseSchema.parse(demo)).toEqual(demo);
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...demo,
        factSources: {
          schemaVersion: 1,
          entries: [
            { path: "/sections", source: { ...synthetic, trustedSeed: { seedId: "secret" } } },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      usPlanDetailResponseSchema.safeParse({
        ...demo,
        confirmations: { ...demo.confirmations, procedures: { ...synthetic, trustedSeed: {} } },
      }).success,
    ).toBe(false);
  });
});
