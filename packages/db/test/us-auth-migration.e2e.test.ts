import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US auth additive migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url, 113);
    await fixture.pool.query(
      `INSERT INTO "user" (id, name, email) VALUES ('legacy-user', 'Synthetic legacy user', 'legacy@example.test')`,
    );
    await fixture.pool.query(
      `INSERT INTO session (id, token, user_id, expires_at, updated_at) VALUES ('legacy-session', 'synthetic-legacy-session-token', 'legacy-user', now() + interval '1 day', now())`,
    );
    await fixture.pool.query(readFileSync("migrations/0114_us_session_assurance.sql", "utf8"));
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves pre-migration users and sessions without implicitly enabling MFA", async () => {
    const result = await fixture.pool.query(
      `SELECT "user".id, two_factor_enabled, session.id AS session_id FROM "user" JOIN session ON session.user_id = "user".id`,
    );
    expect(result.rows).toEqual([
      { id: "legacy-user", two_factor_enabled: false, session_id: "legacy-session" },
    ]);
    expect(
      (await fixture.pool.query("SELECT count(*)::int AS count FROM us_session_assurances")).rows,
    ).toEqual([{ count: 0 }]);
  });

  it("enforces assurance foreign keys and a single factor per user", async () => {
    await expect(
      fixture.pool.query(
        "INSERT INTO us_session_assurances (session_id, factor_id) VALUES ('missing-session', 'missing-factor')",
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await fixture.pool.query(
      "INSERT INTO us_two_factors (id, secret, backup_codes, user_id) VALUES ('factor-a', 'synthetic-encrypted-value', 'synthetic-encrypted-backup', 'legacy-user')",
    );
    await expect(
      fixture.pool.query(
        "INSERT INTO us_two_factors (id, secret, backup_codes, user_id) VALUES ('factor-b', 'synthetic-encrypted-value', 'synthetic-encrypted-backup', 'legacy-user')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await fixture.pool.query(
      "INSERT INTO us_session_assurances (session_id, factor_id) VALUES ('legacy-session', 'factor-a')",
    );
    await fixture.pool.query(`DELETE FROM "user" WHERE id = 'legacy-user'`);
    expect(
      (await fixture.pool.query("SELECT count(*)::int AS count FROM us_session_assurances")).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await fixture.pool.query("SELECT count(*)::int AS count FROM us_two_factors")).rows,
    ).toEqual([{ count: 0 }]);
  });
});
