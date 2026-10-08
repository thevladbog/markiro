import { readFileSync } from "node:fs";

import { DomainError, formatShiftNumber, shiftMonthKey } from "@markiro/domain";
import { describe, expect, it } from "vitest";
import { z } from "zod";

// See test/protocol.test.ts: bind import.meta.url before building the URL.
const testModuleUrl = import.meta.url;

/**
 * `proto/fixtures/shift-numbers.json`, read strictly: the cases the host's
 * shift number (`host/src/shifts.rs`) and the domain's answer alike.
 */
const NUMBERS = z
  .strictObject({
    monthKeys: z.array(z.strictObject({ date: z.string(), monthKey: z.string().nullable() })),
    numbers: z.array(
      z.strictObject({
        monthKey: z.string(),
        seq: z.number().int().positive(),
        createdFrom: z.enum(["office", "station"]),
        number: z.string(),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL("../proto/fixtures/shift-numbers.json", testModuleUrl), "utf8"),
    ),
  );

describe("shift numbers: the fixture the host's shift number answers too", () => {
  it("holds 22 dates and 5 numbers", () => {
    expect(NUMBERS.monthKeys).toHaveLength(22);
    expect(NUMBERS.numbers).toHaveLength(5);
  });

  it.each(NUMBERS.monthKeys.map((each) => [each.date, each.monthKey] as const))(
    "reads the month of %j as the host does",
    (date, monthKey) => {
      if (monthKey === null) {
        expect(() => shiftMonthKey(date)).toThrow(DomainError);
      } else {
        expect(shiftMonthKey(date)).toBe(monthKey);
      }
    },
  );

  it.each(NUMBERS.numbers.map((each) => [each.number, each] as const))(
    "writes %s as the host does",
    (number, each) => {
      // The host's `office` is the cloud's `admin`.
      const createdFrom = each.createdFrom === "office" ? "admin" : "station";
      expect(formatShiftNumber({ monthKey: each.monthKey, seq: each.seq, createdFrom })).toBe(
        number,
      );
    },
  );
});
