import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { ownerCommandEnvironment, readOwnerPassword } from "./deployment/us-owner-command";
import { UsDevelopmentOwnerStore } from "./deployment/us-development-owner";

async function main() {
  const env = ownerCommandEnvironment(process.argv.slice(2), process.env);
  // Do not echo a password typed into a visible terminal.
  if (process.stdin.isTTY) throw new Error("stdin_pipe_required");
  const password = await readOwnerPassword(process.stdin);
  const connection = createDb(env.DATABASE_URL, {
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  connection.pool.on("error", () => {});
  try {
    const identity = await connection.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name, current_user AS owner",
    );
    if (identity.rows[0]?.name !== "markiro_us_dev" || identity.rows[0]?.owner !== "markiro_us")
      throw new Error("database_identity_mismatch");
    // No migrations, schema repair, profile selection, sessions or business seed.
    const result = await new UsDevelopmentOwnerStore(connection.db).provision(
      password,
      randomUUID(),
    );
    console.log(JSON.stringify({ ...result, synthetic: true, mfaRequired: true }));
  } finally {
    await connection.pool.end();
  }
}

void main().catch(() => {
  // Never print driver errors: they may contain credential-bearing SQL.
  console.error(
    "US synthetic owner provisioning refused. Check confirmation, isolated migrated database and password input. Existing identities are never reset.",
  );
  process.exitCode = 1;
});
