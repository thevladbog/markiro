/** Image-only synthetic fixture; not a production command. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { appPassword, migratorPassword } = JSON.parse(
  await readFile("/fixture/credentials.json", "utf8"),
);
const url = (user, password) => {
  const value = new URL("postgresql://db.private:5432/markiro");
  value.username = user;
  value.password = password;
  value.searchParams.set("sslmode", "verify-full");
  value.searchParams.set("sslrootcert", "/fixture/ca.crt");
  return value.href;
};
let boss;
let phase = "migrations";
try {
  const { runRuntimeMigrations } = await import("./runtime-migrate.mjs");
  const { PgBoss } = require("pg-boss");
  await runRuntimeMigrations({
    databaseUrl: url("markiro_migrator", migratorPassword),
    migrationsFolder: "/opt/backup/fixture/migrations",
    log: () => {},
  });
  phase = "pg-boss";
  boss = new PgBoss({
    connectionString: url("markiro_app", appPassword),
    schema: "pgboss_platform",
    createSchema: false,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => {});
  await boss.start();
  await boss.createQueue("backup-synthetic");
  await boss.send("backup-synthetic", { kind: "synthetic-only" });
} catch (error) {
  await writeFile(
    "/fixture/probe-failure.json",
    JSON.stringify({
      phase,
      code: /^[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : "UNKNOWN",
    }),
    { mode: 0o600 },
  );
  process.stderr.write(
    `Backup fixture failed; code=${/^[A-Z0-9_]+$/u.test(error.code ?? "") ? error.code : "UNKNOWN"}.\n`,
  );
  process.exitCode = 1;
} finally {
  await boss?.stop({ graceful: false }).catch(() => {});
}
