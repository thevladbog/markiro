import { describe, expect, it } from "vitest";
import { z } from "zod";

import { reasonNeed, stationReasonRequired } from "../src/floor/close/shared-reason.js";
import { fixture } from "./support/proto-fixture.js";

const CASES = z
  .object({
    cases: z.array(
      z.object({
        closesShift: z.boolean(),
        participantsEver: z.number().int(),
        factPlanned: z.number().int().nullable(),
        actualQty: z.number().int(),
        hostPlanned: z.number().int().nullable(),
        shiftAccepted: z.number().int(),
        need: z.enum(["none", "required", "shared"]),
      }),
    ),
  })
  .parse(fixture("shift-close-reason-shared.json")).cases;

describe("the reason a close needs (plan 2b, host D7)", () => {
  it("is the host's rule, case for case of the shared fixture", () => {
    expect(CASES.length).toBeGreaterThanOrEqual(8);
    for (const { need, ...rule } of CASES) {
      expect(reasonNeed(rule), JSON.stringify(rule)).toBe(need);
    }
  });

  it("is asked of a station alone in its shift exactly as stage 2a did, with the link or without", () => {
    const alone = { participantsEver: 1, closesShift: true, total: 99 };
    expect(stationReasonRequired({ ...alone, plannedQty: 100, actualQty: 99, online: false })).toBe(
      true,
    );
    expect(stationReasonRequired({ ...alone, plannedQty: 100, actualQty: 100, online: true })).toBe(
      false,
    );
    expect(stationReasonRequired({ ...alone, plannedQty: null, actualQty: 5, online: true })).toBe(
      false,
    );
  });

  it("is asked of a shared close only online, of the last closer, by the whole shift against the plan", () => {
    const shared = { plannedQty: 1200, actualQty: 427, participantsEver: 2 };
    expect(stationReasonRequired({ ...shared, closesShift: true, online: true, total: 547 })).toBe(
      true,
    );
    expect(stationReasonRequired({ ...shared, closesShift: true, online: true, total: 1200 })).toBe(
      false,
    );
    expect(stationReasonRequired({ ...shared, closesShift: false, online: true, total: 547 })).toBe(
      false,
    );
    // Offline the station cannot know it is last (spec §12.9): the host marks the reason missing.
    expect(stationReasonRequired({ ...shared, closesShift: true, online: false, total: 547 })).toBe(
      false,
    );
    expect(
      stationReasonRequired({
        ...shared,
        plannedQty: null,
        closesShift: true,
        online: true,
        total: 547,
      }),
    ).toBe(false);
  });
});
