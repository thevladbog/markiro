import { describe, expect, it } from "vitest";
import { parseSupportPayload } from "../src/modules/standalone-diagnostics/support-payload";
import { supportPayloadV1, supportPayloadV2 } from "./support/standalone-support-token";

const NOW = new Date("2026-10-20T09:00:00.000Z");

describe("support payload validation (plan ДИАГ А2)", () => {
  it("accepts v1 and v2", () => {
    expect(parseSupportPayload(supportPayloadV1(), NOW)).toMatchObject({ ok: true });
    expect(parseSupportPayload(supportPayloadV2(), NOW)).toMatchObject({ ok: true });
  });

  it("answers payload_invalid for an unknown field, a bad month or an array", () => {
    expect(parseSupportPayload({ ...supportPayloadV2(), secret: 1 }, NOW)).toEqual({
      ok: false,
      reason: "payload_invalid",
    });
    expect(parseSupportPayload([], NOW)).toEqual({ ok: false, reason: "payload_invalid" });
    const unordered = supportPayloadV2({ months: ["2026-10", "2026-09"] });
    expect(parseSupportPayload(unordered, NOW)).toEqual({ ok: false, reason: "payload_invalid" });
  });

  it("cuts a generated instant more than a day ahead of the server clock, accepts the past", () => {
    const at = (iso: string) => parseSupportPayload(supportPayloadV2({ generatedAt: iso }), NOW);
    expect(at("2026-10-21T08:59:59.000Z")).toMatchObject({ ok: true });
    expect(at("2026-10-21T09:00:01.000Z")).toEqual({ ok: false, reason: "generated_in_future" });
    expect(at("2020-01-01T00:00:00.000Z")).toMatchObject({ ok: true });
  });
});
