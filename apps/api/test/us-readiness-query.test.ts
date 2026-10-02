import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  parseUsReadinessQuery,
  resolveUsReadinessScope,
} from "../src/modules/traceability/trace/us-readiness-query";

const lotId = "11111111-1111-4111-8111-111111111111";

describe("US readiness query and civil scope", () => {
  it("defaults to the first day of the month 23 months before the tenant civil month", () => {
    expect(
      resolveUsReadinessScope(parseUsReadinessQuery({}), "2026-09-28", "US_FSMA204_PROCESSOR"),
    ).toEqual({
      eventDateFrom: "2024-10-01",
      eventDateTo: "2026-09-28",
      productId: null,
      lotId: null,
      profileCode: "US_FSMA204_PROCESSOR",
      defaulted: true,
    });
    expect(resolveUsReadinessScope({}, "2024-02-29", "US_GENERIC_LOT_TRACEABILITY")).toMatchObject({
      eventDateFrom: "2022-03-01",
      eventDateTo: "2024-02-29",
    });
    expect(resolveUsReadinessScope({}, "2026-01-01", "US_FSMA204_PROCESSOR")).toMatchObject({
      eventDateFrom: "2024-02-01",
      eventDateTo: "2026-01-01",
    });
  });

  it("preserves exact custom bounds and nullable filters", () => {
    expect(
      resolveUsReadinessScope(
        parseUsReadinessQuery({
          eventDateFrom: "2024-02-29",
          eventDateTo: "2024-03-01",
          lotId,
        }),
        "2026-09-28",
        "US_FSMA204_PROCESSOR",
      ),
    ).toEqual({
      eventDateFrom: "2024-02-29",
      eventDateTo: "2024-03-01",
      lotId,
      productId: null,
      profileCode: "US_FSMA204_PROCESSOR",
      defaulted: false,
    });
  });

  it("keeps accepted civil years 0001–0099 in their own century", () => {
    expect(resolveUsReadinessScope({}, "0026-09-28", "US_FSMA204_PROCESSOR")).toMatchObject({
      eventDateFrom: "0024-10-01",
      eventDateTo: "0026-09-28",
    });
  });

  it.each([
    ["0001-01-01", "0001-01-01"],
    ["0002-11-01", "0001-01-01"],
    ["0002-12-01", "0001-01-01"],
  ])("clamps an unrepresentable default lookback for tenant day %s", (today, from) => {
    expect(resolveUsReadinessScope({}, today, "US_FSMA204_PROCESSOR")).toEqual({
      eventDateFrom: from,
      eventDateTo: today,
      productId: null,
      lotId: null,
      profileCode: "US_FSMA204_PROCESSOR",
      defaulted: true,
    });
  });

  it("permits exactly 24 distinct custom calendar months and rejects 25", () => {
    expect(() =>
      parseUsReadinessQuery({ eventDateFrom: "2024-02-29", eventDateTo: "2026-01-01" }),
    ).not.toThrow();
    expect(() =>
      parseUsReadinessQuery({ eventDateFrom: "2024-01-31", eventDateTo: "2026-01-01" }),
    ).toThrow(BadRequestException);
    expect(() =>
      parseUsReadinessQuery({ eventDateFrom: "2024-12-31", eventDateTo: "2026-11-01" }),
    ).not.toThrow();
  });

  it("returns exact safe 400 errors for malformed queries", () => {
    for (const query of [
      { eventDateFrom: "2026-01-01" },
      { eventDateTo: "2026-01-01" },
      { eventDateFrom: "2026-02-30", eventDateTo: "2026-03-01" },
      { eventDateFrom: "2026-09-29", eventDateTo: "2026-09-28" },
      { eventDateFrom: "2024-01-01", eventDateTo: "2026-01-01" },
      { lotId: "bad" },
      { unknown: "value" },
    ]) {
      try {
        parseUsReadinessQuery(query);
        throw new Error("Expected query rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toEqual({ code: "us_invalid_query" });
      }
    }
  });
});
