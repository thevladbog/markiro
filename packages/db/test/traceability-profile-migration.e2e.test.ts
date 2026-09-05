import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("traceability profile migration on isolated US PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url, 112);
    await fixture.pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('legacy-a', 'Synthetic A', 'synthetic-a', '2020-02-29T12:00:00Z'), ('legacy-b', 'Synthetic B', 'synthetic-b', '2021-01-01T00:00:00Z')`,
    );
    await fixture.pool.query(readFileSync("migrations/0113_traceability_profiles.sql", "utf8"));
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("backfills historical RU identity without changing timezone defaults", async () => {
    const result = await fixture.pool.query(
      "SELECT tenant_id, code, retention_years, effective_at = organization.created_at AS preserves_creation FROM traceability_profiles JOIN organization ON tenant_id = organization.id ORDER BY tenant_id",
    );
    expect(result.rows).toEqual([
      { tenant_id: "legacy-a", code: "RU_CHZ", retention_years: 5, preserves_creation: true },
      { tenant_id: "legacy-b", code: "RU_CHZ", retention_years: 5, preserves_creation: true },
    ]);
    const zone = await fixture.pool.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'org_profiles' AND column_name = 'time_zone'",
    );
    expect(zone.rows[0]?.column_default).toBe("'Europe/Moscow'::text");
  });

  it("enforces baseline, retention, tenant uniqueness and foreign keys in PostgreSQL", async () => {
    await fixture.pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('new-us', 'Synthetic US', 'new-us', now())",
    );
    for (const baseline of [null, "", "   "]) {
      await expect(
        fixture.pool.query(
          "INSERT INTO traceability_profiles (tenant_id, code, baseline_version) VALUES ('new-us', 'US_FSMA204_PROCESSOR', $1)",
          [baseline],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      fixture.pool.query(
        "INSERT INTO traceability_profiles (tenant_id, code, baseline_version, retention_years) VALUES ('new-us', 'US_FSMA204_PROCESSOR', 'baseline', 1)",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        "INSERT INTO traceability_profiles (tenant_id, code) VALUES ('missing-tenant', 'RU_CHZ')",
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await fixture.pool.query(
      "INSERT INTO traceability_profiles (tenant_id, code, baseline_version) VALUES ('new-us', 'US_FSMA204_PROCESSOR', 'US-REG-2026-09-03')",
    );
    await expect(
      fixture.pool.query(
        "INSERT INTO traceability_profiles (tenant_id, code) VALUES ('new-us', 'RU_CHZ')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
