import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@markiro/db";
import { ShiftsService } from "../src/modules/shifts/shifts.service";
import type { OperatorsService } from "../src/modules/operators/operators.service";
import type { SsccService } from "../src/modules/sscc/sscc.service";
import type { EntitlementsService } from "../src/subscriptions/entitlements.service";

type QueryResult = { rows: Record<string, unknown>[] };

function summaryService(results: QueryResult[]) {
  const dialect = new PgDialect();
  const queries: { sql: string; params: unknown[] }[] = [];
  const execute = vi.fn(async (query: SQL) => {
    const compiled = dialect.sqlToQuery(query);
    queries.push({ sql: compiled.sql, params: compiled.params });
    const result = results.shift();
    if (!result) throw new Error("Unexpected summary query");
    return result;
  });
  const transaction = vi.fn(async (run: (tx: { execute: typeof execute }) => Promise<unknown>) =>
    run({ execute }),
  );
  const db = { transaction } as unknown as Db;
  const service = new ShiftsService(
    db,
    {} as OperatorsService,
    {} as SsccService,
    {} as EntitlementsService,
  );
  return { service, transaction, queries };
}

describe("ShiftsService.getShiftSummary", () => {
  it("returns validation output and factual employee activity without exposing badges", async () => {
    const harness = summaryService([
      {
        rows: [
          {
            mode: "validation",
            generatedAt: "2026-09-02T09:00:00.000Z",
            validationAcceptedUnits: 14,
            aggregationClosedBoxes: 0,
            aggregationContainedUnits: 0,
          },
        ],
      },
      {
        rows: [
          {
            employeeId: "10000000-0000-4000-8000-000000000001",
            fullName: "Анна Соколова",
            role: "Оператор линии",
            firstActivityAt: "2026-09-02T06:00:00.000Z",
            lastActivityAt: "2026-09-02T08:45:00.000Z",
            eventCount: 18,
            acceptedScans: 14,
            closedBoxes: 2,
          },
          {
            employeeId: null,
            fullName: null,
            role: null,
            firstActivityAt: "2026-09-02T07:00:00.000Z",
            lastActivityAt: "2026-09-02T07:30:00.000Z",
            eventCount: 3,
            acceptedScans: 2,
            closedBoxes: 0,
          },
        ],
      },
    ]);

    await expect(harness.service.getShiftSummary("tenant-1", "shift-1")).resolves.toEqual({
      generatedAt: "2026-09-02T09:00:00.000Z",
      output: { mode: "validation", acceptedUnits: 14 },
      participants: [
        {
          employeeId: "10000000-0000-4000-8000-000000000001",
          fullName: "Анна Соколова",
          role: "Оператор линии",
          firstActivityAt: "2026-09-02T06:00:00.000Z",
          lastActivityAt: "2026-09-02T08:45:00.000Z",
          acceptedScans: 14,
          closedBoxes: 2,
        },
      ],
      unattributed: { eventCount: 3, acceptedScans: 2, closedBoxes: 0 },
    });

    expect(harness.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(harness.queries).toHaveLength(2);
    for (const query of harness.queries) {
      expect(query.params).toContain("tenant-1");
      expect(query.params).toContain("shift-1");
      expect(query.sql).not.toContain("employee_badges");
      expect(query.sql).not.toContain("badge_code");
    }
  });

  it("returns authoritative aggregation output", async () => {
    const harness = summaryService([
      {
        rows: [
          {
            mode: "aggregation",
            generatedAt: new Date("2026-09-02T09:00:00.000Z"),
            validationAcceptedUnits: 0,
            aggregationClosedBoxes: "6",
            aggregationContainedUnits: "57",
          },
        ],
      },
      { rows: [] },
    ]);

    const summary = await harness.service.getShiftSummary("tenant-1", "shift-1");

    expect(summary.output).toEqual({ mode: "aggregation", closedBoxes: 6, containedUnits: 57 });
    expect(summary.participants).toEqual([]);
    expect(summary.unattributed).toEqual({ eventCount: 0, acceptedScans: 0, closedBoxes: 0 });
  });

  it("returns 404 without running the employee query when the shift is absent or foreign", async () => {
    const harness = summaryService([{ rows: [] }]);

    await expect(
      harness.service.getShiftSummary("tenant-1", "foreign-shift"),
    ).rejects.toMatchObject({ status: 404 });
    expect(harness.queries).toHaveLength(1);
  });
});
