import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "@markiro/db";

/** API-local fixture: never consumes DATABASE_URL or migrates a caller's DB. */
export async function createUsProfileTestDatabase(
  raw: string,
): Promise<ReturnType<typeof createDb> & { close(): Promise<void> }> {
  const url = new URL(raw);
  if (
    url.protocol !== "postgres:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.pathname !== "/markiro_us_dev" ||
    url.username !== "markiro_us" ||
    url.search ||
    url.hash
  ) {
    throw new Error("US tests require the isolated loopback database");
  }
  const admin = createDb(url.toString());
  const name = `markiro_us_profile_${randomUUID().replaceAll("-", "_")}`;
  let created = false;
  url.pathname = `/${name}`;
  const scratch = createDb(url.toString());
  async function close() {
    await scratch.pool.end();
    try {
      // Only this invocation's successfully created random target is removed.
      if (created) await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.pool.end();
    }
  }
  try {
    const identity = await admin.pool.query(
      "SELECT current_database() AS name, current_user AS owner",
    );
    if (identity.rows[0]?.name !== "markiro_us_dev" || identity.rows[0]?.owner !== "markiro_us") {
      throw new Error("US database identity mismatch");
    }
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(scratch.db, { migrationsFolder: resolve("../../packages/db/migrations") });
    return { ...scratch, close };
  } catch (error) {
    await close();
    throw error;
  }
}
