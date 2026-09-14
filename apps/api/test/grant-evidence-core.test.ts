import { describe, expect, it } from "vitest";
import {
  evidenceIdentity,
  sanitizeEvidencePayload,
  retainedGrant,
} from "../src/modules/device-grants/evidence-core";

describe("evidence canonical identity and sensitive retention", () => {
  it("keeps retry identity stable across epochs but separates owners and operations", () => {
    const owner = {
      tenantId: "tenant",
      deviceId: "device",
      kind: "station" as const,
      credentialEpoch: 1,
    };
    expect(evidenceIdentity(owner, "scans", "one")).toBe(
      evidenceIdentity(Object.assign({}, owner, { credentialEpoch: 2 }), "scans", "one"),
    );
    expect(evidenceIdentity(owner, "scans", "one")).not.toBe(
      evidenceIdentity({ ...owner, deviceId: "another" }, "scans", "one"),
    );
    expect(evidenceIdentity(owner, "scans", "one")).not.toBe(
      evidenceIdentity(owner, "leave", "one"),
    );
  });
  it("retains exact manufacturing bytes but hashes raw credentials without mutating input", () => {
    const payload = {
      badgeCode: "badge-secret",
      admissionProof: "proof-secret",
      items: [{ rawKm: "010123\u001d91AB" }],
      badgeDigest: "existing-digest",
    };
    const retained = sanitizeEvidencePayload(payload);
    expect(JSON.stringify(retained)).not.toContain("badge-secret");
    expect(JSON.stringify(retained)).not.toContain("proof-secret");
    expect(retained.items).toEqual(payload.items);
    expect(retained.badgeDigest).toBe("existing-digest");
    expect(payload.badgeCode).toBe("badge-secret");
  });
  it("does not treat arbitrary compact input as an issued authority", () => {
    expect(retainedGrant("e30.e30.AA", "different")).toBeNull();
    expect(retainedGrant("e30.e30.AA", "e30.e30.AA")).toBeNull();
  });
});
