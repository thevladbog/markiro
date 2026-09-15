import { describe, expect, it } from "vitest";
import { servicePeriodState } from "../src/modules/service-periods/service-period-read-model";

describe("service period read model", () => {
  const at = new Date("2026-09-15T00:00:00.000Z");

  it.each([
    ["upcoming", "2026-09-15T00:00:00.001Z", "2026-10-15T00:00:00.001Z"],
    ["active", "2026-08-15T00:00:00.000Z", "2026-09-15T00:00:00.001Z"],
    ["expired", "2026-08-15T00:00:00.000Z", "2026-09-15T00:00:00.000Z"],
  ] as const)("classifies %s periods at exact boundaries", (expected, startsAt, endsAt) => {
    expect(servicePeriodState({ startsAt: new Date(startsAt), endsAt: new Date(endsAt) }, at)).toBe(
      expected,
    );
  });
});
