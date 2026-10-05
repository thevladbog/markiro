import { describe, expect, it } from "vitest";
import { resolveUsRequestDeadline } from "../src/traceability/requests/deadline.js";

describe("US request deadline", () => {
  it("rejects received precision that would be silently truncated", () => {
    expect(() => resolveUsRequestDeadline("2026-01-01T00:00:00.123456Z")).toThrow(
      "us_request_invalid_instant",
    );
  });

  it("rejects an explicit deadline one microsecond after the default", () => {
    expect(() =>
      resolveUsRequestDeadline("2026-01-01T00:00:00.123Z", "2026-01-02T00:00:00.123001Z"),
    ).toThrow("us_request_invalid_instant");
  });

  it("accepts exactly representable trailing-zero fractions", () => {
    expect(
      resolveUsRequestDeadline("2026-01-01T00:00:00.123000Z", "2026-01-02T05:30:00.123000+05:30"),
    ).toEqual({ dueAt: "2026-01-02T00:00:00.123Z", alternateDeadlineReason: null });
  });

  it("adds exactly 24 elapsed hours across a spring DST change", () => {
    const received = "2026-03-08T01:30:00-08:00";
    const result = resolveUsRequestDeadline(received);
    expect(result).toEqual({
      dueAt: "2026-03-09T09:30:00.000Z",
      alternateDeadlineReason: null,
    });
    expect(Date.parse(result.dueAt) - Date.parse(received)).toBe(86_400_000);
  });

  it("requires a reason only for a genuinely different UTC due instant", () => {
    const received = "2026-09-17T09:00:00-07:00";
    expect(resolveUsRequestDeadline(received, "2026-09-18T16:00:00Z")).toEqual({
      dueAt: "2026-09-18T16:00:00.000Z",
      alternateDeadlineReason: null,
    });
    expect(() => resolveUsRequestDeadline(received, "2026-09-19T16:00:00Z")).toThrow(RangeError);
    expect(
      resolveUsRequestDeadline(received, "2026-09-19T16:00:00Z", " Agreed extension "),
    ).toEqual({
      dueAt: "2026-09-19T16:00:00.000Z",
      alternateDeadlineReason: "Agreed extension",
    });
    expect(() => resolveUsRequestDeadline(received, "2026-09-17T16:00:00Z")).toThrow(RangeError);
    expect(() => resolveUsRequestDeadline(received, "2026-09-17T15:59:59Z", "Earlier")).toThrow(
      RangeError,
    );
  });

  it.each([
    "not-a-date",
    "2026-01-01",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:60:00Z",
    "2026-01-01T00:00:60Z",
    "2026-01-01T00:00:00+24:00",
    "2026-01-01T00:00:00+01:60",
    "2026-01-01T00:00:00+0100",
    "0000-01-01T00:00:00Z",
    "10000-01-01T00:00:00Z",
    "0001-01-01T00:00:00+00:01",
    "9999-12-31T23:59:59-00:01",
  ])("rejects invalid received and explicit due instants: %s", (instant) => {
    expect(() => resolveUsRequestDeadline(instant)).toThrow(RangeError);
    expect(() => resolveUsRequestDeadline("2026-01-01T00:00:00Z", instant, "Alternate")).toThrow(
      RangeError,
    );
  });

  it("rejects default overflow even with an explicit alternate deadline", () => {
    expect(() => resolveUsRequestDeadline("9999-12-31T23:59:59Z")).toThrow(RangeError);
    expect(() =>
      resolveUsRequestDeadline("9999-12-31T23:59:58Z", "9999-12-31T23:59:59Z", "Earlier"),
    ).toThrow(RangeError);
    expect(resolveUsRequestDeadline("9999-12-30T23:59:59.999Z").dueAt).toBe(
      "9999-12-31T23:59:59.999Z",
    );
  });

  it.each([undefined, null, "", "  ", "ab", "a".repeat(2001)])(
    "rejects missing, short or oversized alternate reason: %s",
    (reason) => {
      expect(() =>
        resolveUsRequestDeadline("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", reason),
      ).toThrow(RangeError);
    },
  );

  it("accepts reason limits and a positive shorter deadline", () => {
    expect(
      resolveUsRequestDeadline("2026-01-01T00:00:00Z", "2026-01-01T00:00:01Z", " abc "),
    ).toEqual({ dueAt: "2026-01-01T00:00:01.000Z", alternateDeadlineReason: "abc" });
    const reason = "a".repeat(2000);
    expect(
      resolveUsRequestDeadline("2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", reason),
    ).toEqual({ dueAt: "2026-01-03T00:00:00.000Z", alternateDeadlineReason: reason });
  });

  it("canonicalizes positive offsets, fractions and the earliest supported year", () => {
    expect(resolveUsRequestDeadline("2024-02-29T23:59:59.123+05:30")).toEqual({
      dueAt: "2024-03-01T18:29:59.123Z",
      alternateDeadlineReason: null,
    });
    expect(resolveUsRequestDeadline("0001-01-01T00:00:00Z").dueAt).toBe("0001-01-02T00:00:00.000Z");
    expect(
      resolveUsRequestDeadline("2026-01-01T00:00:00Z", "2026-01-02T05:30:00+05:30", "ignored"),
    ).toEqual({ dueAt: "2026-01-02T00:00:00.000Z", alternateDeadlineReason: null });
  });
});
