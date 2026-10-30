import { describe, expect, it } from "vitest";
import { HostError } from "../src/host/client.js";
import { palletCreationFailureKey } from "../src/office/codes/pallet-creation-errors.js";
describe("office pallet creation refusal copy", () => {
  it.each([
    "org_gln_missing",
    "license_restricted",
    "feature_disabled",
    "restore_hold",
    "sscc_reserved",
  ])("explains %s in product terms", (constraint) => {
    expect(
      palletCreationFailureKey(
        new HostError({
          kind: "api",
          code: "conflict",
          message: constraint,
          details: { constraint },
        }),
      ),
    ).toBe(`office.createPallet.failures.${constraint}`);
  });
});
