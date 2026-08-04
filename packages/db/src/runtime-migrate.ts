import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const advisoryLockKeys = [1296126539, 1230131023];

export type RuntimeMigrationResult = {
  packaged: readonly string[];
  completedAt: string;
};

export type RuntimeMigrationOptions = {
  databaseUrl: string;
  migrationsFolder: string;
  log?: (message: string) => void;
  now?: () => Date;
};

export async function runRuntimeMigrations(
  options: RuntimeMigrationOptions,
): Promise<RuntimeMigrationResult> {
  if (!options.databaseUrl.trim()) {
    throw new Error("DATABASE_URL is required");
  }

  const log = options.log ?? console.log;
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  let primaryError: unknown;
  let cleanupError: unknown;
  let result: RuntimeMigrationResult | undefined;

  try {
    const packaged = await readPackagedMigrationTags(options.migrationsFolder);
    log("runtime migration started");
    for (const tag of packaged) {
      log(`migration packaged: ${tag}`);
    }

    pool = new pg.Pool({ connectionString: options.databaseUrl });
    const db = drizzle(pool);
    client = await pool.connect();
    let lockAcquired = false;
    let migrationError: unknown;
    let unlockError: unknown;

    try {
      await client.query("SELECT pg_advisory_lock($1, $2)", advisoryLockKeys);
      lockAcquired = true;
      await migrate(db, { migrationsFolder: options.migrationsFolder });
    } catch (error) {
      migrationError = error;
    } finally {
      if (lockAcquired) {
        try {
          await client.query("SELECT pg_advisory_unlock($1, $2)", advisoryLockKeys);
        } catch (error) {
          unlockError = error;
        }
      }
    }

    if (migrationError !== undefined) {
      throw asError(migrationError);
    }
    if (unlockError !== undefined) {
      throw asError(unlockError);
    }

    const completedAt = (options.now ?? (() => new Date()))().toISOString();
    result = { packaged, completedAt };
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      client?.release();
    } catch (error) {
      cleanupError = error;
    }

    try {
      await pool?.end();
    } catch (error) {
      cleanupError ??= error;
    }
  }

  if (primaryError !== undefined) {
    log("runtime migration failed");
    throw asError(primaryError);
  }
  if (cleanupError !== undefined) {
    log("runtime migration failed");
    throw asError(cleanupError);
  }

  log("runtime migration completed");
  return result!;
}

async function readPackagedMigrationTags(migrationsFolder: string): Promise<readonly string[]> {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as unknown;

  if (!isRecord(journal) || !Array.isArray(journal.entries)) {
    throw new Error("Invalid migration journal");
  }

  return journal.entries.map((entry) => {
    if (!isRecord(entry) || typeof entry.tag !== "string" || !entry.tag.trim()) {
      throw new Error("Invalid migration journal");
    }

    return entry.tag;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error("runtime migration failed");
}
