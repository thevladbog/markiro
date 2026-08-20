import { pgTable, timestamp } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { toExclusiveEnd, upperBoundCondition } from "../src/lib/date-range";

const t = pgTable("t", { createdAt: timestamp("created_at", { withTimezone: true }) });

/** Pulls the comparison operator (` < ` / ` <= `) and the bound `Date` param out of a drizzle `SQL` condition. */
function inspect(condition: ReturnType<typeof upperBoundCondition>): {
  op: string;
  value: unknown;
} {
  if (!condition) throw new Error("expected a condition");
  const chunks = condition.queryChunks as unknown[];
  const opChunk = chunks.find(
    (c): c is { value: string[] } =>
      typeof c === "object" &&
      c !== null &&
      "value" in c &&
      Array.isArray((c as { value: unknown }).value) &&
      ((c as { value: string[] }).value[0] ?? "").includes("<"),
  );
  const paramChunk = chunks.find(
    (c): c is { value: unknown } =>
      typeof c === "object" &&
      c !== null &&
      "value" in c &&
      (c as { value: unknown }).value instanceof Date,
  );
  return { op: opChunk!.value[0]!, value: paramChunk?.value };
}

describe("toExclusiveEnd", () => {
  it("returns the start of the next UTC day", () => {
    const next = toExclusiveEnd(new Date("2026-08-20T00:00:00.000Z"));
    expect(next.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });
});

describe("upperBoundCondition", () => {
  it("returns undefined when no bound is given", () => {
    expect(upperBoundCondition(t.createdAt, undefined)).toBeUndefined();
  });

  it("date-only bound (admin sends YYYY-MM-DD): exclusive `lt` against the start of the next day", () => {
    const condition = upperBoundCondition(t.createdAt, {
      date: new Date("2026-08-20T00:00:00.000Z"),
      dateOnly: true,
    });
    const { op, value } = inspect(condition);
    expect(op).toBe(" < ");
    expect((value as Date).toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("explicit midnight timestamp is NOT treated as date-only: inclusive `lte` at the exact instant", () => {
    // Regression: `2026-08-20T00:00:00.000Z` coerces to the same midnight-UTC
    // `Date` a bare `2026-08-20` would, but the caller marks it dateOnly:
    // false because the RAW string carried a real time-of-day -- see
    // `listCodesQuerySchema`/`listDocumentsQuerySchema`'s `dateBoundSchema`.
    const condition = upperBoundCondition(t.createdAt, {
      date: new Date("2026-08-20T00:00:00.000Z"),
      dateOnly: false,
    });
    const { op, value } = inspect(condition);
    expect(op).toBe(" <= ");
    expect((value as Date).toISOString()).toBe("2026-08-20T00:00:00.000Z");
  });
});
