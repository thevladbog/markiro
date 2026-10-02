import { describe, expect, it } from "vitest";
import { parseUsPlanDraftRow } from "../src/modules/traceability/plans/us-plan-model";
import type { schema } from "@markiro/db";

function row(): typeof schema.traceabilityPlanVersions.$inferSelect {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "synthetic-tenant",
    versionNumber: 1,
    status: "draft",
    draftRevision: 1,
    schemaVersion: 1,
    changeSummary: "",
    createdBy: "actor-1",
    createdAt: new Date("2026-10-02T00:00:00.000Z"),
    updatedAt: new Date("2026-10-02T00:00:00.000Z"),
    approvedBy: null,
    approvedAt: null,
    configSnapshot: null,
    configDigest: null,
    approvedEvidence: null,
    idempotencyKeyHash: null,
    approvalRequestDigest: null,
    pdfObjectKey: null,
    pdfSha256: null,
    pdfByteSize: null,
    rendererVersion: null,
    supersededById: null,
    supersededAt: null,
    retainThrough: null,
    sections: {
      recordMaintenance: {
        systemOfRecord: "",
        formats: [],
        recordLocations: [],
        responsibleRoles: [],
        backupAndRecovery: "",
        narrative: [],
      },
      ftlIdentification: { procedure: "", reviewCadence: "" },
      tlcAssignment: { procedure: "" },
      pointOfContact: { name: "", title: "", phone: "", email: null },
      farmActivity: { status: "unknown", explanation: "" },
      reviewAndUpdate: { procedure: "" },
    },
  };
}

describe("US plan stored draft model", () => {
  it("returns parsed detached sections with pending ownership and serialized timestamps", () => {
    const input = row();
    const result = parseUsPlanDraftRow(input);
    expect(result).toEqual({
      id: input.id,
      versionNumber: 1,
      status: "draft",
      draftRevision: 1,
      schemaVersion: 1,
      sections: input.sections,
      changeSummary: "",
      createdBy: "actor-1",
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
      statementOwnership: "operator_pending",
    });
    expect(result.sections).not.toBe(input.sections);
    expect(result).not.toHaveProperty("approvedBy");
  });

  it.each([
    null,
    {},
    { farmActivity: { status: "no" } },
    { ...(row().sections as object), synthetic: true },
  ])("fails closed on malformed stored sections: %j", (sections) => {
    expect(() => parseUsPlanDraftRow({ ...row(), sections })).toThrow("Service Unavailable");
  });

  it.each([
    { status: "effective" },
    { approvedBy: "actor-1" },
    { configSnapshot: {} },
    { approvedEvidence: {} },
    { idempotencyKeyHash: "a".repeat(64) },
    { approvalRequestDigest: "b".repeat(64) },
    { schemaVersion: 2 },
    { draftRevision: 0 },
    { updatedAt: new Date("invalid") },
  ])("rejects invalid draft metadata: %j", (update) => {
    expect(() => parseUsPlanDraftRow({ ...row(), ...update })).toThrow("Service Unavailable");
  });
});
