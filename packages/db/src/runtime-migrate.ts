import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const advisoryLockKeys = [1296126539, 1230131023];
const connectionTimeoutMs = 30_000;
const advisoryLockTimeoutMs = 120_000;
const statementTimeoutMs = 900_000;

export type RuntimeMigrationResult = {
  packaged: readonly string[];
  completedAt: string;
};

export type RuntimeMigrationOptions = {
  databaseUrl: string;
  migrationsFolder: string;
  log?: (message: string) => void;
  now?: () => Date;
  connectionTimeoutMs?: number;
  advisoryLockTimeoutMs?: number;
  statementTimeoutMs?: number;
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

    pool = new pg.Pool({
      connectionString: options.databaseUrl,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? connectionTimeoutMs,
    });
    client = await pool.connect();
    const db = drizzle(client);
    let migrationError: unknown;
    let unlockError: unknown;

    try {
      await client.query(
        "SELECT set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
        [
          `${options.advisoryLockTimeoutMs ?? advisoryLockTimeoutMs}ms`,
          `${options.statementTimeoutMs ?? statementTimeoutMs}ms`,
        ],
      );
      await client.query("SELECT pg_advisory_lock($1, $2)", advisoryLockKeys);
      const offerVariantIndex = packaged.indexOf("0127_dark_beyonder");
      if (offerVariantIndex < 0) {
        await migrate(db, { migrationsFolder: options.migrationsFolder });
      } else {
        await migrateWithOnlineOfferVariants(
          client,
          options.migrationsFolder,
          offerVariantIndex,
          packaged.indexOf("0136_validate_working_device_events"),
        );
      }
    } catch (error) {
      migrationError = error;
    } finally {
      try {
        await client.query("SELECT pg_advisory_unlock($1, $2)", advisoryLockKeys);
      } catch (error) {
        unlockError = error;
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

// 0127's immutable SQL remains the canonical schema/hash (and the empty-database
// Drizzle path). Live upgrades execute its equivalent in resumable online stages.
// Keep the same session advisory lock across predecessor, online and successor work.
async function migrateWithOnlineOfferVariants(
  client: pg.PoolClient,
  migrationsFolder: string,
  index: number,
  validationIndex: number,
): Promise<void> {
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const { NodePgSession } = await import("drizzle-orm/node-postgres");
  const migrations = readMigrationFiles({ migrationsFolder });
  const migration = migrations[index];
  if (migration?.hash !== "f07b534840ce77c40ac44dde9152de32599e8edb1784188ea55452dfb3e89f6c") {
    throw new Error("Online offer variant migration hash mismatch");
  }
  const dialect = new PgDialect();
  const session = new NodePgSession<Record<string, never>, Record<string, never>>(
    client,
    dialect,
    undefined,
  );
  await dialect.migrate(migrations.slice(0, index), session, { migrationsFolder });
  const latest = await client.query<{ created_at: string }>(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  if (Number(latest.rows[0]?.created_at ?? 0) < migration.folderMillis) {
    const timeout = await client.query<{ lock_timeout: string }>("SHOW lock_timeout");
    const previousTimeout = timeout.rows[0]?.lock_timeout;
    if (!previousTimeout) throw new Error("Missing migration lock timeout");
    await client.query("SELECT set_config('lock_timeout', '5s', false)");
    try {
      await prepareOnlineOfferVariants(client);
      await client.query("BEGIN");
      try {
        await client.query(`ALTER TABLE public.commercial_offer_documents
          ADD CONSTRAINT commercial_offer_documents_offer_revision_format_variant_uq
          UNIQUE USING INDEX commercial_offer_documents_offer_revision_format_variant_uq`);
        await client.query(`ALTER TABLE public.commercial_offer_documents
          DROP CONSTRAINT commercial_offer_documents_offer_revision_format_uq`);
        await client.query(
          "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
          [migration.hash, migration.folderMillis],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      await client.query("SELECT set_config('lock_timeout', $1, false)", [previousTimeout]);
    }
  }
  if (validationIndex > index) {
    // Drizzle otherwise wraps every pending migration in one transaction. Release
    // 0135's ADD CONSTRAINT lock before 0136 scans the existing event journal.
    // Retain the session advisory lock and each migration's atomic journal entry.
    await dialect.migrate(migrations.slice(index + 1, validationIndex), session, {
      migrationsFolder,
    });
    await dialect.migrate(migrations.slice(validationIndex, validationIndex + 1), session, {
      migrationsFolder,
    });
    await dialect.migrate(migrations.slice(validationIndex + 1), session, { migrationsFolder });
  } else {
    await dialect.migrate(migrations.slice(index + 1), session, { migrationsFolder });
  }
}

async function prepareOnlineOfferVariants(client: pg.PoolClient): Promise<void> {
  // The old constraint protects every intermediate state. Do not guess how to
  // repair an unjournaled/manual schema change that removed it.
  const old = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = 'public.commercial_offer_documents'::regclass
      AND conname = 'commercial_offer_documents_offer_revision_format_uq' AND contype = 'u'`,
  );
  if (old.rowCount !== 1) throw new Error("Missing predecessor offer document uniqueness");
  await client.query(`ALTER TABLE public.commercial_offer_documents
    ADD COLUMN IF NOT EXISTS print_variant text DEFAULT 'clean' NOT NULL`);
  await client.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.commercial_offer_documents'::regclass
        AND conname = 'commercial_offer_documents_print_variant_check') THEN
      ALTER TABLE public.commercial_offer_documents
        ADD CONSTRAINT commercial_offer_documents_print_variant_check
        CHECK (print_variant IN ('clean', 'signed')) NOT VALID;
    END IF;
  END $$`);
  // This scan is deliberately not in the ADD CONSTRAINT transaction.
  await client.query(`ALTER TABLE public.commercial_offer_documents
    VALIDATE CONSTRAINT commercial_offer_documents_print_variant_check`);
  const existing = await client.query<{ indisvalid: boolean; definition: string }>(
    `SELECT indisvalid, pg_get_indexdef(indexrelid) AS definition FROM pg_index
      WHERE indexrelid = to_regclass('public.commercial_offer_documents_offer_revision_format_variant_uq')`,
  );
  const prepared = existing.rows[0];
  if (
    prepared &&
    prepared.definition !==
      "CREATE UNIQUE INDEX commercial_offer_documents_offer_revision_format_variant_uq ON public.commercial_offer_documents USING btree (offer_id, revision, format, print_variant)"
  ) {
    throw new Error("Unexpected prepared offer variant index");
  }
  // A cancelled concurrent build leaves an INVALID index. IF NOT EXISTS alone
  // would silently reuse it. Only rebuild the exact index owned by this stage.
  if (prepared && !prepared.indisvalid) {
    await client.query(
      "DROP INDEX CONCURRENTLY public.commercial_offer_documents_offer_revision_format_variant_uq",
    );
  }
  if (!prepared?.indisvalid) {
    await client.query(`CREATE UNIQUE INDEX CONCURRENTLY commercial_offer_documents_offer_revision_format_variant_uq
      ON public.commercial_offer_documents (offer_id, revision, format, print_variant)`);
  }
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
