import { describe, expect, it } from "vitest";
import {
  assertCounterTransition,
  expectedCounterTransition,
  type CounterRow,
  type NewRootEvidence,
} from "./support/us-dataset-counter-preservation";

function item<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("Missing explicit test fixture item");
  return value;
}

const tenant = "counter-owner";
const row = (table: string, year: number, sequence: number, tenantId = tenant): CounterRow => ({
  table,
  key: `["${tenantId}", ${year}]`,
  body: { tenant_id: tenantId, year, sequence },
});
function root(kind: string, n: number, eventNumber: string): NewRootEvidence {
  const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    kind,
    id,
    tenant_id: tenant,
    event_number: eventNumber,
    event_id: id,
    event_tenant_id: tenant,
    event_type: kind,
    root_event_id: id,
    original_event_number: eventNumber,
    revision: 1,
    created_at: "2026-10-12T09:00:00.000Z",
    time_zone: "America/New_York",
  };
}
const before = () => [
  row("receiving_counters", 2026, 7),
  row("shipping_counters", 2026, 11),
  row("transformation_counters", 2026, 3),
  row("receiving_counters", 2025, 99),
  row("receiving_counters", 2026, 81, "other-tenant"),
];
const roots = () => [
  root("receiving", 1, "REC-26-0008"),
  root("receiving", 2, "REC-26-0009"),
  root("transformation", 3, "TRN-26-0004"),
  root("shipping", 4, "SHP-26-0012"),
];
const after = () => [
  row("receiving_counters", 2026, 9),
  row("shipping_counters", 2026, 12),
  row("transformation_counters", 2026, 4),
  row("receiving_counters", 2025, 99),
  row("receiving_counters", 2026, 81, "other-tenant"),
];

describe("exact native resume allocator oracle", () => {
  // Dropped allocations, after-sequence-derived expectations or foreign changes must fail.
  it("derives exactly 2 Receiving / 1 Transformation / 1 Shipping and preserves other facts", () => {
    const original = before();
    item(original, 0).body.retained = { note: "unchanged" };
    const expected = after();
    item(expected, 0).body.retained = { note: "unchanged" };
    const saved = structuredClone(original);
    expect(expectedCounterTransition(original, roots(), tenant)).toEqual(expected);
    expect(original).toEqual(saved);
    expect(() => assertCounterTransition(original, roots(), tenant, expected)).not.toThrow();
  });

  it.each(["UTC", "Pacific/Honolulu", "Asia/Tokyo"])(
    "ignores machine TZ=%s across saved-zone rollover",
    (machineZone) => {
      const previous = process.env.TZ;
      process.env.TZ = machineZone;
      try {
        const evidence = roots();
        evidence[0] = {
          ...root("receiving", 1, "REC-26-0008"),
          created_at: "2027-01-01T00:30:00.000Z",
        };
        evidence[1] = {
          ...root("receiving", 2, "REC-27-0001"),
          created_at: "2027-01-01T05:30:00.000Z",
        };
        expect(expectedCounterTransition(before(), evidence, tenant)).toEqual([
          row("receiving_counters", 2026, 8),
          row("shipping_counters", 2026, 12),
          row("transformation_counters", 2026, 4),
          row("receiving_counters", 2025, 99),
          row("receiving_counters", 2026, 81, "other-tenant"),
          row("receiving_counters", 2027, 1),
        ]);
      } finally {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
      }
    },
  );

  it("starts all new-year counters at one and leaves every old-year row unchanged", () => {
    const evidence = [
      root("receiving", 1, "REC-27-0001"),
      root("receiving", 2, "REC-27-0002"),
      root("transformation", 3, "TRN-27-0001"),
      root("shipping", 4, "SHP-27-0001"),
    ].map((value) => ({
      ...value,
      created_at: "2026-12-31T23:30:00.000Z",
      time_zone: "Asia/Tokyo",
    }));
    expect(expectedCounterTransition(before(), evidence, tenant)).toEqual([
      ...before(),
      row("receiving_counters", 2027, 2),
      row("transformation_counters", 2027, 1),
      row("shipping_counters", 2027, 1),
    ]);
  });

  const mutations: [string, (rows: CounterRow[]) => void][] = [
    [
      "under increment",
      (rows) => {
        item(rows, 0).body.sequence = 8;
      },
    ],
    [
      "over increment",
      (rows) => {
        item(rows, 0).body.sequence = 10;
      },
    ],
    [
      "missing key",
      (rows) => {
        rows.splice(0, 1);
      },
    ],
    [
      "extra key",
      (rows) => {
        rows.push(row("receiving_counters", 2027, 1));
      },
    ],
    [
      "foreign increment",
      (rows) => {
        item(rows, 4).body.sequence++;
      },
    ],
    [
      "old year increment",
      (rows) => {
        item(rows, 3).body.sequence++;
      },
    ],
    [
      "wrong year",
      (rows) => {
        item(rows, 0).body.year++;
      },
    ],
    [
      "wrong tenant",
      (rows) => {
        item(rows, 0).body.tenant_id = "foreign";
      },
    ],
    [
      "extra field",
      (rows) => {
        item(rows, 0).body.unrelated = true;
      },
    ],
    [
      "duplicate key",
      (rows) => {
        rows.push(structuredClone(item(rows, 0)));
      },
    ],
    [
      "unknown table",
      (rows) => {
        item(rows, 0).table = "unknown_counters";
      },
    ],
  ];
  it.each(mutations)("rejects entire observed state with %s", (_name, mutate) => {
    const observed = after();
    mutate(observed);
    expect(() => assertCounterTransition(before(), roots(), tenant, observed)).toThrow();
  });
  it("rejects changed or missing preexisting unrelated fields", () => {
    const original = before();
    item(original, 0).body.extra = "preserved";
    expect(() => assertCounterTransition(original, roots(), tenant, after())).toThrow();
    const observed = after();
    item(observed, 0).body.extra = "changed";
    expect(() => assertCounterTransition(original, roots(), tenant, observed)).toThrow();
  });

  const invalid: [string, (values: NewRootEvidence[]) => void][] = [
    [
      "missing root",
      (values) => {
        values.pop();
      },
    ],
    [
      "extra root",
      (values) => {
        values.push(root("receiving", 5, "REC-26-0010"));
      },
    ],
    [
      "foreign root",
      (values) => {
        item(values, 0).tenant_id = "foreign";
      },
    ],
    [
      "foreign original event",
      (values) => {
        item(values, 0).event_tenant_id = "foreign";
      },
    ],
    [
      "wrong kind",
      (values) => {
        item(values, 0).kind = "shipping";
      },
    ],
    [
      "unknown kind",
      (values) => {
        item(values, 0).kind = "unknown";
      },
    ],
    [
      "duplicate ID",
      (values) => {
        item(values, 1).id = item(values, 0).id;
        item(values, 1).event_id = item(values, 0).id;
        item(values, 1).root_event_id = item(values, 0).id;
      },
    ],
    [
      "duplicate number",
      (values) => {
        item(values, 1).event_number = "REC-26-0008";
        item(values, 1).original_event_number = "REC-26-0008";
      },
    ],
    [
      "gap",
      (values) => {
        item(values, 1).event_number = "REC-26-0010";
        item(values, 1).original_event_number = "REC-26-0010";
      },
    ],
    [
      "reused number",
      (values) => {
        item(values, 0).event_number = "REC-26-0007";
        item(values, 0).original_event_number = "REC-26-0007";
      },
    ],
    [
      "wrong year",
      (values) => {
        item(values, 0).event_number = "REC-25-0008";
        item(values, 0).original_event_number = "REC-25-0008";
      },
    ],
    [
      "wrong original number",
      (values) => {
        item(values, 0).original_event_number = "REC-26-0001";
      },
    ],
    [
      "revision2",
      (values) => {
        item(values, 0).revision = 2;
      },
    ],
    [
      "missing original",
      (values) => {
        item(values, 0).event_id = null;
      },
    ],
    [
      "wrong original ID",
      (values) => {
        item(values, 0).event_id = item(values, 2).id;
      },
    ],
    [
      "wrong root pointer",
      (values) => {
        item(values, 0).root_event_id = item(values, 2).id;
      },
    ],
    [
      "wrong original kind",
      (values) => {
        item(values, 0).event_type = "shipping";
      },
    ],
    [
      "invalid ID",
      (values) => {
        item(values, 0).id = "invalid";
      },
    ],
    [
      "invalid timezone",
      (values) => {
        item(values, 0).time_zone = "Not/AZone";
      },
    ],
    [
      "missing timezone",
      (values) => {
        item(values, 0).time_zone = null;
      },
    ],
    [
      "invalid date",
      (values) => {
        item(values, 0).created_at = "2026-02-30T09:00:00.000Z";
      },
    ],
    [
      "ambiguous instant",
      (values) => {
        item(values, 0).created_at = "2026-10-12T09:00:00";
      },
    ],
    [
      "NaN date",
      (values) => {
        item(values, 0).created_at = "not-a-date";
      },
    ],
    [
      "unformatted number",
      (values) => {
        item(values, 0).event_number = "REC-26-8";
        item(values, 0).original_event_number = "REC-26-8";
      },
    ],
  ];
  it.each(invalid)("rejects %s allocation evidence", (_name, mutate) => {
    const evidence = roots();
    mutate(evidence);
    expect(() => expectedCounterTransition(before(), evidence, tenant)).toThrow();
  });

  it.each(["REC-26-0000", "REC-26-00008", "SHP-26-0008", "REC-26-9007199254740992"])(
    "rejects malformed number %s even when original and root agree",
    (number) => {
      const evidence = roots();
      item(evidence, 0).event_number = number;
      item(evidence, 0).original_event_number = number;
      expect(() => expectedCounterTransition(before(), evidence, tenant)).toThrow();
    },
  );
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid saved sequence %s",
    (sequence) => {
      const original = before();
      item(original, 0).body.sequence = sequence;
      expect(() => expectedCounterTransition(original, roots(), tenant)).toThrow();
    },
  );
  it("accepts unordered allocation evidence and whole relations without changing facts", () => {
    expect(() =>
      assertCounterTransition(before(), roots().reverse(), tenant, after().reverse()),
    ).not.toThrow();
  });

  it.each(
    mutations.filter(([name]) =>
      ["duplicate key", "unknown table", "wrong year", "wrong tenant"].includes(name),
    ),
  )("rejects malformed before rows: %s", (_name, mutate) => {
    const original = before();
    mutate(original);
    expect(() => expectedCounterTransition(original, roots(), tenant)).toThrow();
  });
});
