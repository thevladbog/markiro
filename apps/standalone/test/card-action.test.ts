import { describe, expect, it } from "vitest";

import { cardAction } from "../src/floor/shifts/ShiftCard.js";
import type { ShiftCopy } from "../src/floor/shifts/shift-copies.js";

const DEVICE = "7c1a2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "0e2b1f7a-6c1d-4b8e-9f3a-2d4c5b6a7e8f";

function copy(patch: Partial<ShiftCopy>): ShiftCopy {
  return {
    status: "planned",
    localState: null,
    ownerDeviceId: null,
    entered: false,
    ...patch,
  } as ShiftCopy;
}

describe("a shift card's action while the license opens no new shift (plan ЛЦ-3)", () => {
  it("explains a planned shift and nothing else: the open shift of this station goes on", () => {
    expect(cardAction(copy({}), DEVICE, true, "license_restricted")).toEqual({
      kind: "blocked",
      refusal: "license_restricted",
    });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: DEVICE }),
        DEVICE,
        false,
        "license_restricted",
      ),
    ).toEqual({ kind: "continue", enabled: false });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: DEVICE, entered: true }),
        DEVICE,
        false,
        "license_trial_expired",
      ),
    ).toEqual({ kind: "continue", enabled: true });
    expect(
      cardAction(
        copy({ status: "active", ownerDeviceId: OTHER }),
        DEVICE,
        true,
        "license_inn_mismatch",
      ),
    ).toEqual({ kind: "busy" });
    expect(cardAction(copy({ status: "closed" }), DEVICE, true, "license_restricted")).toEqual({
      kind: "finish",
    });
    expect(cardAction(copy({ localState: "closing" }), DEVICE, true, "license_restricted")).toEqual(
      {
        kind: "closing",
      },
    );
  });

  it("opens a planned shift as before without a refusal", () => {
    expect(cardAction(copy({}), DEVICE, true)).toEqual({ kind: "open", enabled: true });
    expect(cardAction(copy({}), DEVICE, false, null)).toEqual({ kind: "open", enabled: false });
  });
});
