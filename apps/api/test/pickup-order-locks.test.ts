import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { lockPickupOrderTransaction } from "../src/modules/pickup-orders/pickup-order-locks";

function renderedQueries(): {
  executor: { execute: (query: unknown) => Promise<unknown> };
  queries: { sql: string; params: unknown[] }[];
} {
  const dialect = new PgDialect();
  const rendered: { sql: string; params: unknown[] }[] = [];
  return {
    queries: rendered,
    executor: {
      execute: async (query) => {
        rendered.push(dialect.sqlToQuery(query as SQL));
        return {};
      },
    },
  };
}

describe("pickup order advisory lock order", () => {
  it("takes the registry root before the employee/day lock for box orders", async () => {
    const capture = renderedQueries();
    await lockPickupOrderTransaction(capture.executor as never, {
      tenantId: "tenant",
      employeeId: "employee",
      utcDay: "2026-08-13",
    });
    expect(capture.queries).toHaveLength(2);
    expect(capture.queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(capture.queries[0]?.params).toContain("box-registry:tenant");
    expect(capture.queries[1]?.params).toContain("pickup-limit:tenant:employee:2026-08-13");
  });

  // Loose (item-only) orders take the SAME tenant-wide registry root, not
  // just box-bearing ones: `validateBoxCandidates` can classify a box
  // `written_off` purely from a code-level pickup lock (no
  // `pickup_order_boxes` row at all), so disaggregation's `applyDocument`
  // must be able to rely on this lock serializing against every pickup
  // order, loose or box-bearing, to be safe from a same-gap race. See
  // pickup-order-locks.ts's doc comment for the full story.
  it("also takes the registry root for loose (item-only) orders", async () => {
    const capture = renderedQueries();
    await lockPickupOrderTransaction(capture.executor as never, {
      tenantId: "tenant",
      employeeId: "employee",
      utcDay: "2026-08-13",
    });
    expect(capture.queries).toHaveLength(2);
    expect(capture.queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(capture.queries[0]?.params).toContain("box-registry:tenant");
    expect(capture.queries[1]?.params).toEqual(
      expect.arrayContaining(["pickup-limit:tenant:employee:2026-08-13"]),
    );
  });
});
