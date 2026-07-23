import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { ensurePartitions, partitionName, pgCode } from "../src/partitions.js";
import type { Db } from "../src/client.js";

describe("pgCode", () => {
  it("reads a raw pg error code", () => {
    expect(pgCode({ code: "42P07" })).toBe("42P07");
  });
  it("reads a drizzle-wrapped error code from cause", () => {
    const wrapped = Object.assign(new Error("Failed query"), {
      cause: { code: "42P07" },
    });
    expect(pgCode(wrapped)).toBe("42P07");
  });
  it("returns undefined otherwise", () => {
    expect(pgCode(new Error("boom"))).toBeUndefined();
  });
});

describe("ensurePartitions race tolerance", () => {
  it("swallows drizzle-wrapped 42P07 from a concurrent winner", async () => {
    const raced = Object.assign(new Error("Failed query: CREATE TABLE"), {
      cause: { code: "42P07" },
    });
    // ensurePartitions alternates probe → create per parent; odd calls are
    // existence probes ("missing"), even calls are CREATEs losing the race.
    let call = 0;
    const fakeDb = {
      execute: () => {
        call += 1;
        return call % 2 === 1 ? Promise.resolve({ rows: [] }) : Promise.reject(raced);
      },
    } as unknown as Db;
    const created = await ensurePartitions(fakeDb, [new Date(Date.UTC(2001, 1, 1))]);
    expect(created).toEqual([]); // both parents lost the race, none reported created
  });
});

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("ensurePartitions", () => {
  const { db, pool } = createDb(url!);
  afterAll(() => pool.end());

  // A fixed, arbitrary historical month rather than "now" -- the current
  // month's partitions already exist on any DB the API has booted against
  // (see JobsModule/PgBossService, which ensures current + next month at
  // startup), so asserting creation against "now" is non-idempotent across
  // runs/environments. 2001-01 will never collide with real traffic.
  beforeAll(async () => {
    await db.execute(`DROP TABLE IF EXISTS "codes_200101", "scan_events_200101"`);
  });

  it("names partitions by month", () => {
    expect(partitionName("codes", new Date(Date.UTC(2026, 6, 15)))).toBe("codes_202607");
  });
  it("creates children idempotently", async () => {
    const month = new Date(Date.UTC(2001, 0, 1));
    const first = await ensurePartitions(db, [month]);
    const second = await ensurePartitions(db, [month]);
    expect(first).toContain("codes_200101");
    expect(second).toEqual([]); // already exists
  });
});
