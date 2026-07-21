import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { ensurePartitions, partitionName } from "../src/partitions.js";

const url = process.env.DATABASE_URL;
describe.skipIf(!url)("ensurePartitions", () => {
  const { db, pool } = createDb(url!);
  afterAll(() => pool.end());

  it("names partitions by month", () => {
    expect(partitionName("codes", new Date(Date.UTC(2026, 6, 15)))).toBe("codes_202607");
  });
  it("creates children idempotently", async () => {
    const month = new Date(Date.UTC(2026, 6, 1));
    const first = await ensurePartitions(db, [month]);
    const second = await ensurePartitions(db, [month]);
    expect(first).toContain("codes_202607");
    expect(second).toEqual([]); // already exists
  });
});
