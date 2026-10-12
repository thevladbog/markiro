import { describe, expect, it } from "vitest";
import { resolveUsRequestDeadline } from "@markiro/domain";
import {
  formatRequestInstant,
  requestCountdown,
  resolveRequestWallTime,
} from "../src/us/requests/time.js";

describe("tenant wall time", () => {
  it("uses the tenant zone rather than the browser default", () => {
    expect(resolveRequestWallTime("2026-10-05T12:34:56.123", "America/Los_Angeles")).toEqual({
      kind: "unique",
      candidates: [{ instant: "2026-10-05T19:34:56.123Z", offsetSeconds: -25_200 }],
    });
    expect(resolveRequestWallTime("2026-10-05T12:34:56.123", "Asia/Kathmandu")).toEqual({
      kind: "unique",
      candidates: [{ instant: "2026-10-05T06:49:56.123Z", offsetSeconds: 20_700 }],
    });
  });
  it("rejects a gap and retains both tenant fold offsets", () => {
    expect(resolveRequestWallTime("2026-03-08T02:30:00.000", "America/Los_Angeles")).toEqual({
      kind: "gap",
    });
    expect(resolveRequestWallTime("2026-11-01T01:30:00.123", "America/Los_Angeles")).toEqual({
      kind: "fold",
      candidates: [
        { instant: "2026-11-01T08:30:00.123Z", offsetSeconds: -25_200 },
        { instant: "2026-11-01T09:30:00.123Z", offsetSeconds: -28_800 },
      ],
    });
  });
  it("resolves a half-hour fold without assuming whole-hour offsets", () => {
    expect(resolveRequestWallTime("2026-04-05T01:45:00.123", "Australia/Lord_Howe")).toEqual({
      kind: "fold",
      candidates: [
        { instant: "2026-04-04T14:45:00.123Z", offsetSeconds: 39_600 },
        { instant: "2026-04-04T15:15:00.123Z", offsetSeconds: 37_800 },
      ],
    });
  });
  it("uses elapsed 24 hours across a DST change", () => {
    expect(resolveUsRequestDeadline("2026-03-08T08:30:00.123Z").dueAt).toBe(
      "2026-03-09T08:30:00.123Z",
    );
  });
  it.each([
    ["2024-02-29T00:00:00.123", "2024-02-29T00:00:00.123Z"],
    ["0099-01-01T00:00:00.000", "0099-01-01T00:00:00.000Z"],
    ["0001-01-01T00:00:00.000", "0001-01-01T00:00:00.000Z"],
    ["9999-12-30T23:59:59.999", "9999-12-30T23:59:59.999Z"],
    ["9999-12-31T23:59:59.999", "9999-12-31T23:59:59.999Z"],
  ])("preserves valid civil bounds %s", (wall, instant) => {
    expect(resolveRequestWallTime(wall, "UTC")).toEqual({
      kind: "unique",
      candidates: [{ instant, offsetSeconds: 0 }],
    });
  });
  it.each([
    "2026-02-29T00:00:00.000",
    "2026-04-31T00:00:00.000",
    "2026-13-01T00:00:00.000",
    "2026-01-00T00:00:00.000",
    "2026-10-05T24:00:00.000",
    "2026-10-05T12:60:00.000",
    "2026-10-05T12:00:60.000",
    "2026-10-05T12:00:00",
    "2026-10-05T12:00:00.0000",
    "2026-10-05T12:00:00.000Z",
    "0000-01-01T00:00:00.000",
  ])("rejects impossible, imprecise or deadline-out-of-domain input %s", (wall) => {
    expect(resolveRequestWallTime(wall, "UTC")).toEqual({ kind: "invalid" });
  });
  it("rejects an unknown zone without fallback", () => {
    expect(resolveRequestWallTime("2026-10-05T00:00:00.000", "Wrong/Zone")).toEqual({
      kind: "invalid",
    });
  });
  it("requires an IANA zone rather than a fixed-offset zone string", () => {
    expect(resolveRequestWallTime("2026-10-05T00:00:00.000", "+05:30")).toEqual({
      kind: "invalid",
    });
  });
  it("rejects a zone whose instant falls before year 0001", () => {
    expect(resolveRequestWallTime("0001-01-01T00:00:00.000", "Asia/Kathmandu")).toEqual({
      kind: "invalid",
    });
  });
});

describe("deadline presentation", () => {
  const dueAt = "2026-10-06T00:00:00.000Z";
  const dueMs = Date.parse(dueAt);
  it.each([
    [14_400_000, "neutral"],
    [14_399_999, "attention"],
    [0, "attention"],
    [-1, "overdue"],
  ])("classifies %i milliseconds remaining as %s", (milliseconds, kind) => {
    expect(requestCountdown(dueAt, null, dueMs - milliseconds)).toEqual({ kind, milliseconds });
  });
  it("stops the clock at the closure instant", () => {
    expect(requestCountdown(dueAt, "2026-10-05T23:00:00.000Z", dueMs + 1000)).toEqual({
      kind: "closed",
      milliseconds: 3_600_000,
    });
  });
  it.each(["en-US", "es-US"] as const)(
    "formats %s with tenant zone and exact UTC evidence",
    (language) => {
      const text = formatRequestInstant(
        "2026-10-05T19:34:56.123Z",
        "America/Los_Angeles",
        language,
      );
      expect(text).toContain("America/Los_Angeles");
      expect(text).toContain("12:34:56.123");
      expect(text).toContain("2026-10-05T19:34:56.123Z");
    },
  );
});
