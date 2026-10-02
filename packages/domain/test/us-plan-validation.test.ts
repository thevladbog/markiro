import { describe, expect, it } from "vitest";
import { validateUsPlanApproval, type UsPlanApprovalInput } from "../src/index.js";

function fixture(): UsPlanApprovalInput {
  return {
    profileCode: "US_FSMA204_PROCESSOR",
    versionNumber: 1,
    changeSummary: "",
    sections: {
      recordMaintenance: {
        systemOfRecord: "Fictional processor records",
        formats: ["Electronic spreadsheet"],
        recordLocations: ["Fictional facility archive"],
        responsibleRoles: ["QA coordinator"],
        backupAndRecovery: "The coordinator maintains a backup and reviews recovery procedures.",
        narrative: ["Designed to support applicable FSMA 204 recordkeeping requirements."],
      },
      ftlIdentification: {
        procedure: "QA reviews product coverage against the FTL.",
        reviewCadence: "Review when products or the FTL change.",
      },
      tlcAssignment: { procedure: "Assign a TLC and record its source before transformation." },
      pointOfContact: {
        name: "Alex Example",
        title: "QA coordinator",
        phone: "+1 202-555-0100",
        email: "alex@example.com",
      },
      farmActivity: { status: "no", explanation: "This fictional processor does not grow food." },
      reviewAndUpdate: { procedure: "Review and update when practices change." },
    },
    tlcSourceLocationCount: 1,
    provenance: "operational",
    confirmations: { procedures: true, backupAndRecovery: true, contact: true, nonFarmScope: true },
  };
}

const requiredTextFields = [
  ["recordMaintenance", "systemOfRecord"],
  ["recordMaintenance", "backupAndRecovery"],
  ["ftlIdentification", "procedure"],
  ["ftlIdentification", "reviewCadence"],
  ["tlcAssignment", "procedure"],
  ["pointOfContact", "name"],
  ["pointOfContact", "title"],
  ["pointOfContact", "phone"],
  ["reviewAndUpdate", "procedure"],
] as const;

function setText(
  input: UsPlanApprovalInput,
  section: keyof UsPlanApprovalInput["sections"],
  field: string,
  value: string,
) {
  // Mutate only the test-owned fixture, including fields whose keys vary by section.
  Reflect.set(input.sections[section], field, value);
}

describe("US plan approval validation", () => {
  it("accepts a complete fictional non-farm plan without rewriting its text", () => {
    const input = fixture();
    input.sections.pointOfContact.name = "  Alex Example  ";
    const before = structuredClone(input);
    expect(validateUsPlanApproval(input)).toEqual([]);
    expect(input).toEqual(before);
  });

  it.each(requiredTextFields)("requires %s.%s at approval", (section, field) => {
    const input = fixture();
    setText(input, section, field, " \n\t ");
    expect(validateUsPlanApproval(input)).toEqual([
      { code: "required_field", section, path: `${section}.${field}` },
    ]);
  });

  it.each(["formats", "recordLocations", "responsibleRoles"] as const)(
    "requires a nonempty %s list and rejects blank entries",
    (field) => {
      const input = fixture();
      input.sections.recordMaintenance[field] = [];
      expect(validateUsPlanApproval(input)).toEqual([
        {
          code: "required_field",
          section: "recordMaintenance",
          path: `recordMaintenance.${field}`,
        },
      ]);
      input.sections.recordMaintenance[field] = ["Valid entry", "  "];
      expect(validateUsPlanApproval(input)).toEqual([
        {
          code: "required_field",
          section: "recordMaintenance",
          path: `recordMaintenance.${field}.1`,
        },
      ]);
    },
  );

  it("allows optional email, farm explanation and record-maintenance narrative", () => {
    const input = fixture();
    input.sections.pointOfContact.email = null;
    input.sections.farmActivity.explanation = "";
    input.sections.recordMaintenance.narrative = [];
    expect(validateUsPlanApproval(input)).toEqual([]);
  });

  it("requires a TLC-source location", () => {
    expect(validateUsPlanApproval({ ...fixture(), tlcSourceLocationCount: 0 })).toEqual([
      {
        code: "tlc_source_location_required",
        section: "tlcAssignment",
        path: "tlcSourceLocationCount",
      },
    ]);
  });

  it("requires a change summary for later versions", () => {
    expect(validateUsPlanApproval({ ...fixture(), versionNumber: 2, changeSummary: "  " })).toEqual(
      [{ code: "change_summary_required", section: "plan", path: "changeSummary" }],
    );
    expect(
      validateUsPlanApproval({ ...fixture(), versionNumber: 2, changeSummary: "Updated contact" }),
    ).toEqual([]);
  });

  it("rejects the generic profile", () => {
    expect(
      validateUsPlanApproval({ ...fixture(), profileCode: "US_GENERIC_LOT_TRACEABILITY" }),
    ).toEqual([{ code: "unsupported_profile", section: "plan", path: "profileCode" }]);
  });

  it.each(["yes", "unknown"] as const)("blocks farm activity %s", (status) => {
    const input = fixture();
    input.sections.farmActivity = { status, explanation: "" };
    expect(validateUsPlanApproval(input)).toEqual([
      { code: "farm_scope_unsupported", section: "farmActivity", path: "farmActivity.status" },
    ]);
  });

  it.each([
    ["procedures", "plan"],
    ["backupAndRecovery", "recordMaintenance"],
    ["contact", "pointOfContact"],
    ["nonFarmScope", "farmActivity"],
  ] as const)("requires operational confirmation %s", (confirmation, section) => {
    const input = fixture();
    input.confirmations[confirmation] = false;
    expect(validateUsPlanApproval(input)).toEqual([
      { code: "confirmation_required", section, path: `confirmations.${confirmation}` },
    ]);
  });

  it.each([
    "FDA-approved",
    "FDA   approved",
    "FDA\napproved",
    "FDA-certified",
    "FDA\t certified",
    "FDA\r\ncertified",
    "Official-FDA-integration",
    "Official  FDA   integration",
    "Official\nFDA\nintegration",
    "Guarantees-compliance",
    "Guarantees   compliance",
    "Guarantees\ncompliance",
    "FDA-requires-serialization",
    "FDA  requires  serialization",
    "FDA\nrequires\nserialization",
    "FDA-requires-SSCC",
    "FDA  requires  SSCC",
    "FDA\nrequires\nSSCC",
    "EPCIS-is-required-by-FDA",
    "EPCIS  is  required  by  FDA",
    "EPCIS\nis\nrequired\nby\nFDA",
    "compliance ready",
    "compliance   ready",
    "compliance\nready",
    "FDA\u2011approved",
    "FDA\u2013certified",
  ])("rejects affirmative separator variant %j without rewriting it", (claim) => {
    const input = fixture();
    input.sections.recordMaintenance.narrative = [`This plan is ${claim}.`];
    const before = structuredClone(input);
    expect(validateUsPlanApproval(input)).toEqual([
      {
        code: "prohibited_claim",
        section: "recordMaintenance",
        path: "recordMaintenance.narrative.0",
      },
    ]);
    expect(input).toEqual(before);
  });

  it.each([
    "This plan is not FDA approved.",
    "This plan is NOT FDA-certified.",
    "This plan is not\nFDA   approved.",
    "This service is not official FDA integration.",
    "No official FDA integration is provided.",
    "This plan does not guarantee compliance.",
    "FDA does not require SSCC.",
    "This plan is not compliance-ready.",
    "FDA does not require serialization. EPCIS is not required by FDA.",
  ])("permits explicit simple negative disclaimer %j and retains its bytes", (disclaimer) => {
    const input = fixture();
    input.sections.recordMaintenance.narrative = [disclaimer];
    const before = structuredClone(input);
    expect(validateUsPlanApproval(input)).toEqual([]);
    expect(input).toEqual(before);
  });

  it.each([
    "This plan is not FDA approved. This plan is FDA-approved.",
    "This plan is not FDA approved, but guarantees\ncompliance.",
    "This plan is not FDA approved and is FDA certified.",
    "This plan is not only FDA-approved.",
    "This plan is not not FDA approved.",
    "There is no official FDA integration. Official-FDA-integration is now available.",
  ])("does not let a negation hide an affirmative claim in %j", (text) => {
    const input = fixture();
    input.sections.recordMaintenance.narrative = [text];
    expect(validateUsPlanApproval(input)).toEqual([
      {
        code: "prohibited_claim",
        section: "recordMaintenance",
        path: "recordMaintenance.narrative.0",
      },
    ]);
  });

  it("trusted synthetic provenance bypasses only operational confirmations", () => {
    const input = fixture();
    input.provenance = "trusted_synthetic";
    input.confirmations = {
      procedures: false,
      backupAndRecovery: false,
      contact: false,
      nonFarmScope: false,
    };
    expect(validateUsPlanApproval(input)).toEqual([]);
    input.sections.pointOfContact.name = "";
    input.sections.farmActivity.status = "unknown";
    input.profileCode = "US_GENERIC_LOT_TRACEABILITY";
    input.tlcSourceLocationCount = 0;
    input.sections.recordMaintenance.narrative = ["FDA APPROVED"];
    expect(validateUsPlanApproval(input)).toEqual([
      { code: "farm_scope_unsupported", section: "farmActivity", path: "farmActivity.status" },
      { code: "unsupported_profile", section: "plan", path: "profileCode" },
      { code: "required_field", section: "pointOfContact", path: "pointOfContact.name" },
      {
        code: "prohibited_claim",
        section: "recordMaintenance",
        path: "recordMaintenance.narrative.0",
      },
      {
        code: "tlc_source_location_required",
        section: "tlcAssignment",
        path: "tlcSourceLocationCount",
      },
    ]);
  });

  it.each([
    "FDA approved",
    "fDa CeRtIfIeD",
    "Official FDA integration",
    "GUARANTEES COMPLIANCE",
    "FDA requires serialization",
    "FDA requires SSCC",
    "FDA requires serialization/SSCC",
    "EPCIS is required by FDA",
    "compliance-ready",
  ])("rejects misleading claim %s in a nested narrative paragraph", (claim) => {
    const input = fixture();
    input.sections.recordMaintenance.narrative.push(`Our procedure states: ${claim}.`);
    expect(validateUsPlanApproval(input)).toEqual([
      {
        code: "prohibited_claim",
        section: "recordMaintenance",
        path: "recordMaintenance.narrative.1",
      },
    ]);
  });

  it.each([
    ...requiredTextFields,
    ["pointOfContact", "email"],
    ["farmActivity", "explanation"],
  ] as const)("scans free text %s.%s for claims", (section, field) => {
    const input = fixture();
    setText(input, section, field, "FDA certified");
    expect(validateUsPlanApproval(input)).toEqual([
      { code: "prohibited_claim", section, path: `${section}.${field}` },
    ]);
  });

  it.each(["formats", "recordLocations", "responsibleRoles"] as const)(
    "scans each %s entry",
    (field) => {
      const input = fixture();
      input.sections.recordMaintenance[field].push("FDA approved");
      expect(validateUsPlanApproval(input)).toEqual([
        {
          code: "prohibited_claim",
          section: "recordMaintenance",
          path: `recordMaintenance.${field}.1`,
        },
      ]);
    },
  );

  it("scans the change summary and returns one stable issue per field without raw text", () => {
    const input = fixture();
    input.changeSummary = "FDA approved; FDA certified";
    input.sections.pointOfContact.name = " ";
    input.confirmations.contact = false;
    const expected = [
      { code: "prohibited_claim", section: "plan", path: "changeSummary" },
      { code: "confirmation_required", section: "pointOfContact", path: "confirmations.contact" },
      { code: "required_field", section: "pointOfContact", path: "pointOfContact.name" },
    ];
    expect(validateUsPlanApproval(input)).toEqual(expected);
    expect(validateUsPlanApproval(input)).toEqual(expected);
  });
});
