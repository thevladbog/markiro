import { describe, expect, it } from "vitest";
import type { z } from "zod";

import { HostError } from "../src/host/client.js";
import { MAX_STATIONS } from "../src/host/protocol.js";
import { maxStationsRule } from "../src/lib/rules.js";
import {
  activeStationsOnLine,
  lineFieldsSchema,
  stationsInUse,
} from "../src/office/lines/line-form.js";
import {
  participant,
  PARTICIPANT_B,
  SHARED,
  ACTIVE,
  CLOSED,
  LINE_2,
  LINE_10,
} from "./support/shifts.js";

const message = (rule: z.ZodType, text: string) => rule.safeParse(text).error?.issues[0]?.message;

describe("the line's limit rule (plan 2b)", () => {
  it("takes a whole number from 1 to 16 and nothing else", () => {
    expect(MAX_STATIONS).toBe(16);
    for (const text of ["1", " 2 ", "16"])
      expect(message(maxStationsRule, text), text).toBeUndefined();
    for (const text of ["", " ", "0", "17", "1e1", "2.0", "-1", "012", "много"]) {
      expect(message(maxStationsRule, text), text).toBe("rules.maxStations");
    }
  });
});

describe("the busiest active shift of a line", () => {
  it("counts the active participants of the line's active shifts, the most of them", () => {
    const quiet = {
      ...SHARED,
      id: "a1",
      participants: [participant({ state: "left" }), PARTICIPANT_B],
    };
    expect(activeStationsOnLine([SHARED], LINE_2.id)).toBe(2);
    expect(activeStationsOnLine([quiet, SHARED], LINE_2.id)).toBe(2);
    expect(activeStationsOnLine([quiet], LINE_2.id)).toBe(1);
  });

  it("is zero for a line with no active shift or with one of an older host, null while unread", () => {
    expect(activeStationsOnLine([SHARED], LINE_10.id)).toBe(0);
    expect(activeStationsOnLine([ACTIVE, CLOSED], LINE_2.id)).toBe(0);
    expect(activeStationsOnLine([{ ...SHARED, status: "closed" }], LINE_2.id)).toBe(0);
    expect(activeStationsOnLine(undefined, LINE_2.id)).toBeNull();
  });
});

describe("the form's schema", () => {
  const values = { name: "Линия 2", maxStations: "2" };

  it("takes any limit while the shifts are unread", () => {
    expect(lineFieldsSchema(null).safeParse({ ...values, maxStations: "1" }).success).toBe(true);
  });

  it("refuses a limit below the devices at work, with the text that counts them", () => {
    const schema = lineFieldsSchema(2);
    expect(schema.safeParse(values).success).toBe(true);
    expect(schema.safeParse({ ...values, maxStations: "3" }).success).toBe(true);
    const refused = schema.safeParse({ ...values, maxStations: "1" });
    expect(refused.error?.issues[0]?.message).toBe("office.lines.errors.stationsInUse");
    // A malformed number is the rule's message, not the count's.
    expect(schema.safeParse({ ...values, maxStations: "x" }).error?.issues[0]?.message).toBe(
      "rules.maxStations",
    );
  });
});

describe("the host's refusal of a lower limit", () => {
  it("carries the number of devices at work", () => {
    const refusal = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "more devices work a shift of this line than the new limit",
      details: { constraint: "line_stations_in_use", active: 3 },
    });
    expect(stationsInUse(refusal)).toBe(3);
  });

  it("is nothing for any other failure", () => {
    const other = new HostError({
      kind: "api",
      code: "conflict",
      status: 409,
      message: "x",
      details: { constraint: "line_name" },
    });
    expect(stationsInUse(other)).toBeNull();
    expect(stationsInUse(new Error("x"))).toBeNull();
  });
});
