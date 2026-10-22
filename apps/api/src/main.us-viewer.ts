import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import { viewerCommandEnvironment } from "./deployment/us-viewer-command";
import { readOwnerPassword } from "./deployment/us-owner-command";
import { UsDevelopmentViewerStore } from "./deployment/us-development-viewer";

async function main() {
  const command = viewerCommandEnvironment(process.argv.slice(2), process.env);
  if (process.stdin.isTTY) throw new Error("stdin_pipe_required");
  const password = await readOwnerPassword(process.stdin);
  const connection = createDb(command.env.DATABASE_URL, {
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
    const context = {
      tenantId: command.tenantId,
      originalOwnerId: command.originalOwnerId,
      requestId: randomUUID(),
    };
    const store = new UsDevelopmentViewerStore(connection.db);
    const result =
      command.mode === "provision"
        ? await store.provision(context, password)
        : await store.verify(context, password);
    console.log(JSON.stringify(result));
  } finally {
    await connection.pool.end();
  }
}

void main().catch(() => {
  // Driver, configuration and password errors must never escape into logs.
  console.error(
    "US synthetic viewer command refused. Check exact arguments, isolated migrated database, trusted owner/profile and password input. Existing identities are never repaired or reset.",
  );
  process.exitCode = 1;
});
