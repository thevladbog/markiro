import { fileURLToPath } from "node:url";
import { runRuntimeMigrations } from "./runtime-migrate.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

runRuntimeMigrations({ databaseUrl, migrationsFolder })
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 1;
  });
