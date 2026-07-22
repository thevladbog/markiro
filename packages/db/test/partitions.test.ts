import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { ensurePartitions, partitionName } from "../src/partitions.js";

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
