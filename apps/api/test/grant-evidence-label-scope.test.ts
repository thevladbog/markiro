import { describe, expect, it } from "vitest";
import { matchesPreparedEvidenceScope } from "../src/modules/device-grants/evidence-label-scope";
describe("prepared label grant source binding", () => {
  const event = { shiftId: "shift", policyRevision: "policy", templateDigest: "digest", dpi: 203 };
  const scope = {
    shift: {
      id: "shift",
      mode: "validation",
      validationPrintMode: "duplicate_dm",
      validationPrintPolicyRevision: "policy",
      validationPrintSnapshot: { digest: "digest", spec: { dpi: 203 } },
    },
  };
  it("binds current native acceptance to the independently frozen policy and template", () => {
    expect(matchesPreparedEvidenceScope(scope, event)).toBe(true);
    expect(matchesPreparedEvidenceScope(scope, { ...event, policyRevision: "new-policy" })).toBe(
      false,
    );
    expect(matchesPreparedEvidenceScope(scope, { ...event, templateDigest: "new-template" })).toBe(
      false,
    );
    expect(matchesPreparedEvidenceScope(scope, { ...event, dpi: 300 })).toBe(false);
    expect(matchesPreparedEvidenceScope({}, event)).toBe(false);
  });
});
