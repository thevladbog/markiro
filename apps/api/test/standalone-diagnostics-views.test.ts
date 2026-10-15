import { describe, expect, it } from "vitest";
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  isOlderVersion,
  retentionCutoff,
  sumUsageMonths,
} from "../src/modules/standalone-diagnostics/standalone-diagnostics-views";
import { usageMonth } from "./support/standalone-support-token";

describe("diagnostics views (plan ДИАГ А2)", () => {
  it("sums every counter of a month over hosts and keeps the month key", () => {
    const sum = sumUsageMonths([usageMonth("2026-10", 100), usageMonth("2026-10", 50)]);
    expect(sum.month).toBe("2026-10");
    expect(sum.scans).toEqual({ accepted: 150, duplicates: 128, rejected: 18 });
    expect(sum.boxes.closed).toBe(1170);
    expect(sum.shifts.aggregation).toBe(12);
    expect(sumUsageMonths([usageMonth("2026-10", 7)])).toEqual(usageMonth("2026-10", 7));
  });

  it("compares versions: numeric core, a pre-release is older than its release, unknown is null", () => {
    expect(isOlderVersion("0.2.0", "0.10.0")).toBe(true);
    expect(isOlderVersion("0.10.0", "0.2.0")).toBe(false);
    expect(isOlderVersion("2.1.0-beta.1", "2.1.0")).toBe(true);
    expect(isOlderVersion("2.1.0", "2.1.0-beta.2")).toBe(false);
    expect(isOlderVersion("2.1.0-beta.2", "2.1.0-beta.10")).toBe(true);
    expect(isOlderVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isOlderVersion("dev", "1.0.0")).toBeNull();
    expect(isOlderVersion("1.0.0", "latest")).toBeNull();
  });

  it("round-trips a history cursor and refuses a mangled one", () => {
    const at = new Date("2026-10-14T09:00:00.000Z");
    const id = "11111111-2222-4333-8444-555555555555";
    expect(decodeHistoryCursor(encodeHistoryCursor(at, id))).toEqual({ generatedAt: at, id });
    expect(decodeHistoryCursor("AAAA")).toBeNull();
    expect(decodeHistoryCursor(Buffer.from("x|y").toString("base64url"))).toBeNull();
  });

  it("keeps 24 calendar months", () => {
    expect(retentionCutoff(new Date("2026-10-20T09:00:00.000Z")).toISOString()).toBe(
      "2024-10-20T09:00:00.000Z",
    );
    expect(retentionCutoff(new Date("2026-03-31T00:00:00.000Z")).toISOString()).toBe(
      "2024-03-31T00:00:00.000Z",
    );
  });
});
