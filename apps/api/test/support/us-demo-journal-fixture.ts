import { createHash, randomUUID } from "node:crypto";
import { createDb, type Db } from "@markiro/db";
import { UsDevelopmentOwnerStore } from "../../src/deployment/us-development-owner";
import { UsProfileStore } from "../../src/modules/traceability/profile/us-profile-store";
import type { UsDemoJournalContext } from "../../src/modules/traceability/demo/us-demo-journal-contract";
import { createUsProfileTestDatabase } from "./us-profile-database";

type UsDemoJournalFixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>> & {
  databaseName: string;
  provision(): Promise<UsDemoJournalContext>;
  alternateRole(): Promise<Db>;
  snapshot(includeJournal?: boolean): Promise<Record<string, string>>;
};

/** Owns one disposable DB; genuine origin/profile are created through services. */
export async function createUsDemoJournalFixture(base: string): Promise<UsDemoJournalFixture> {
  const fixture = await createUsProfileTestDatabase(base);
  try {
    const identity = await fixture.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name, current_user AS owner",
    );
    const name = identity.rows[0]?.name;
    if (!name || identity.rows[0]?.owner !== "markiro_us")
      throw new Error("us_demo_fixture_identity_invalid");
    const roles: ReturnType<typeof createDb>[] = [];
    return {
      ...fixture,
      databaseName: name,
      async provision(): Promise<UsDemoJournalContext> {
        // Only this invocation's scratch DB, never the base or another fixture.
        await fixture.pool.query('TRUNCATE TABLE organization, "user" CASCADE');
        const owner = await new UsDevelopmentOwnerStore(fixture.db).provision(
          randomUUID() + randomUUID(),
          randomUUID(),
        );
        await new UsProfileStore(fixture.db).provision(
          owner.tenantId,
          owner.userId,
          { code: "US_FSMA204_PROCESSOR", timeZone: "America/Los_Angeles" },
          randomUUID(),
        );
        return {
          tenantId: owner.tenantId,
          actorUserId: owner.userId,
          expectedDatabaseName: name,
          expectedDatabaseUser: "markiro_us",
        };
      },
      async alternateRole() {
        // Existing PostgreSQL builtin only; no CREATE ROLE, GRANT or global mutation.
        const url = new URL(base);
        url.pathname = `/${name}`;
        url.searchParams.set("options", "-c role=pg_read_all_data");
        const alternate = createDb(url.toString());
        roles.push(alternate);
        const actual = await alternate.pool.query<{ role: string }>("SELECT current_user AS role");
        if (actual.rows[0]?.role !== "pg_read_all_data")
          throw new Error("us_demo_fixture_role_invalid");
        return alternate.db;
      },
      async snapshot(includeJournal = true) {
        const tables = await fixture.pool.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        );
        const result: Record<string, string> = {};
        for (const { tablename } of tables.rows) {
          if (!includeJournal && tablename.startsWith("traceability_demo_seed")) continue;
          if (!/^[a-z_][a-z0-9_]*$/.test(tablename))
            throw new Error("us_demo_fixture_table_invalid");
          const rows = await fixture.pool.query<{ body: unknown }>(
            `SELECT to_jsonb(t) AS body FROM "${tablename}" t ORDER BY to_jsonb(t)::text`,
          );
          // Hash entire rows; assertion failures cannot print credentials/evidence.
          result[tablename] = createHash("sha256").update(JSON.stringify(rows.rows)).digest("hex");
        }
        return result;
      },
      async close() {
        try {
          await Promise.all(roles.map(({ pool }) => pool.end()));
        } finally {
          await fixture.close();
        }
      },
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
