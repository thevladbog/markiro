import { describe, expect, it } from "vitest";
import {
  issueKioskAdmissionProof,
  legacyProoflessOccurrenceAllowed,
  verifyKioskAdmissionProof,
} from "../src/modules/pickup-orders/kiosk-admission-proof";

const secret = "test-proof-secret-that-is-long-enough";
const issuedAt = new Date("2026-08-01T10:00:00.000Z");
const endsAt = new Date("2026-08-01T12:00:00.000Z");
const claimedAt = new Date("2026-08-01T11:00:00.000Z");
const now = new Date("2026-08-10T10:00:00.000Z");
const identity = {
  tenantId: "tenant-a",
  kioskId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
  deviceSeq: 17,
};

describe("kiosk admission proof", () => {
  it("authenticates a genuine occurrence more than seven days after it was queued", () => {
    const proof = issueKioskAdmissionProof({
      secret,
      ...identity,
      issuedAt,
      notAfter: endsAt,
    });
    expect(
      verifyKioskAdmissionProof({
        secrets: [secret],
        proof,
        ...identity,
        claimedAt,
        now,
        expectedEndsAt: endsAt,
      }),
    ).toEqual({ ok: true, occurredAt: claimedAt });
  });

  it.each([
    ["forged", { proof: "not-a-proof" }],
    ["other kiosk", { kioskId: "33333333-3333-4333-8333-333333333333" }],
    ["other tenant", { tenantId: "tenant-b" }],
    ["other subscription", { subscriptionId: "44444444-4444-4444-8444-444444444444" }],
    ["replayed for another sequence", { deviceSeq: 18 }],
    ["backdated before issuance", { claimedAt: new Date("2026-08-01T09:00:00.000Z") }],
    ["post-expiry work", { claimedAt: new Date("2026-08-01T12:00:00.001Z") }],
  ])("rejects %s claims", (_name, override) => {
    const proof = issueKioskAdmissionProof({
      secret,
      ...identity,
      issuedAt,
      notAfter: endsAt,
    });
    expect(
      verifyKioskAdmissionProof({
        secrets: [secret],
        proof,
        ...identity,
        claimedAt,
        now,
        expectedEndsAt: endsAt,
        ...override,
      }),
    ).toEqual({ ok: false });
  });

  it("rejects a proof claiming it was issued in the future", () => {
    const proof = issueKioskAdmissionProof({
      secret,
      ...identity,
      issuedAt: new Date("2026-08-10T10:05:00.001Z"),
      notAfter: endsAt,
    });
    expect(
      verifyKioskAdmissionProof({
        secrets: [secret],
        proof,
        ...identity,
        claimedAt,
        now,
        expectedEndsAt: endsAt,
      }),
    ).toEqual({ ok: false });
  });

  it("accepts the previous key during rotation while new proofs use the current key", () => {
    const previous = "previous-proof-secret-that-is-long-enough";
    const current = "current-proof-secret-that-is-long-enough";
    const oldProof = issueKioskAdmissionProof({
      secret: previous,
      ...identity,
      issuedAt,
      notAfter: endsAt,
    });
    expect(
      verifyKioskAdmissionProof({
        secrets: [current, previous],
        proof: oldProof,
        ...identity,
        claimedAt,
        now,
        expectedEndsAt: endsAt,
      }),
    ).toEqual({ ok: true, occurredAt: claimedAt });

    const newProof = issueKioskAdmissionProof({
      secret: current,
      ...identity,
      issuedAt,
      notAfter: endsAt,
    });
    expect(
      verifyKioskAdmissionProof({
        secrets: [previous],
        proof: newProof,
        ...identity,
        claimedAt,
        now,
        expectedEndsAt: endsAt,
      }),
    ).toEqual({ ok: false });
  });
});

describe("legacy proofless recovery sunset", () => {
  const sunset = new Date("2026-08-17T23:59:59.999Z");
  const startsAt = new Date("2026-08-01T00:00:00.000Z");
  const endsAt = new Date("2026-08-02T00:00:00.000Z");
  const now = new Date("2026-08-10T10:00:00.000Z");
  const allowed = (
    override: Partial<Parameters<typeof legacyProoflessOccurrenceAllowed>[0]> = {},
  ) =>
    legacyProoflessOccurrenceAllowed({
      now,
      configuredSunset: sunset,
      claimedAt: new Date("2026-08-01T12:00:00.000Z"),
      startsAt,
      endsAt,
      ...override,
    });

  it("accepts an over-seven-day legacy occurrence only inside the subscription and rollout windows", () => {
    expect(allowed()).toBe(true);
    expect(allowed({ configuredSunset: undefined })).toBe(false);
    expect(allowed({ now: new Date("2026-08-18T00:00:00.000Z") })).toBe(false);
    expect(allowed({ claimedAt: new Date(startsAt.getTime() - 1) })).toBe(false);
    expect(allowed({ claimedAt: endsAt })).toBe(false);
    expect(allowed({ claimedAt: new Date(now.getTime() + 5 * 60_000 + 1) })).toBe(false);
  });
});
