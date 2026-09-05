import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "../../src/client.js";
import { copyMigrationsThroughIndex } from "./legacy-migrations.js";

/** Never consumes DATABASE_URL: an explicit isolated US test opt-in is required. */
export async function createUsProfileTestDatabase(raw: string, throughIndex?: number) {
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
  let folder: string | undefined;
  async function close() {
    await scratch.pool.end();
    try {
      // The target is generated above, never supplied by the caller; only drop
      // a database this invocation successfully created.
      if (created) await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.pool.end();
      if (folder) await rm(folder, { recursive: true, force: true });
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
    let migrationsFolder = resolve("../../packages/db/migrations");
    if (throughIndex !== undefined) {
      folder = await mkdtemp(join(tmpdir(), "markiro-us-profile-migrations-"));
      await copyMigrationsThroughIndex({
        sourceFolder: migrationsFolder,
        targetFolder: folder,
        lastIncludedIndex: throughIndex,
      });
      migrationsFolder = folder;
    }
    await migrate(scratch.db, { migrationsFolder });
    return { ...scratch, close };
  } catch (error) {
    await close();
    throw error;
  }
}
