import { defineConfig } from "drizzle-kit";

// Regeneration parity only: STATION_MIGRATIONS (src/sqlite/migrations.ts) is
// the authoritative on-device DDL. Run `pnpm --filter @markiro/db
// db:generate:sqlite` to diff the schema against generated SQL when changing
// src/sqlite/schema.ts.
export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/sqlite/schema.ts"],
  out: "./migrations-sqlite",
});
