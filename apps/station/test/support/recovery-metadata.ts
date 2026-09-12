import { DatabaseSync } from "node:sqlite";
import { applyMigrations, type SqlExecutor } from "../../src/lib/mirror.js";

/** Real recovery metadata for UI fixtures that still stub unrelated floor queries. */
export async function openRecoveryMetadata() {
  const db = new DatabaseSync(":memory:");
  const exec: SqlExecutor = {
    async run(query, values = []) {
      db.prepare(query).run(...(values as never[]));
    },
    async all<T>(query: string, values: unknown[] = []): Promise<T[]> {
      return db.prepare(query).all(...(values as never[])) as T[];
    },
  };
  await applyMigrations(exec);
  return {
    exec,
    seed(query: string, values: unknown[] = []) {
      db.prepare(query).run(...(values as never[]));
    },
    handles(query: string) {
      return /^(?:SELECT \* FROM|INSERT INTO|UPDATE|DELETE FROM) station_device_(?:recovery|owners)\b/.test(
        query,
      );
    },
    close() {
      db.close();
    },
  };
}
