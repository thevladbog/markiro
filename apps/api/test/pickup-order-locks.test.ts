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
      hasBoxes: true,
    });
    expect(capture.queries).toHaveLength(2);
    expect(capture.queries[0]?.sql).toContain("pg_advisory_xact_lock");
    expect(capture.queries[0]?.params).toContain("box-registry:tenant");
    expect(capture.queries[1]?.params).toContain("pickup-limit:tenant:employee:2026-08-13");
  });

  it("preserves the legacy loose-only path without the tenant-wide registry lock", async () => {
    const capture = renderedQueries();
    await lockPickupOrderTransaction(capture.executor as never, {
      tenantId: "tenant",
      employeeId: "employee",
      utcDay: "2026-08-13",
      hasBoxes: false,
    });
    expect(capture.queries).toHaveLength(1);
    expect(capture.queries[0]?.params).toEqual(
      expect.arrayContaining(["pickup-limit:tenant:employee:2026-08-13"]),
    );
  });
});
