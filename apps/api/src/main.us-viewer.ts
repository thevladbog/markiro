import { randomUUID } from "node:crypto";
import { createDb } from "@markiro/db";
import {
  createUsViewerCommandObservation,
  viewerCommandEnvironment,
} from "./deployment/us-viewer-command";
import { readOwnerPassword } from "./deployment/us-owner-command";
import { UsDevelopmentViewerStore } from "./deployment/us-development-viewer";

const observation = createUsViewerCommandObservation();

async function main() {
  observation.enter("arguments");
  const command = viewerCommandEnvironment(process.argv.slice(2), process.env);
  observation.enter("stdin");
  if (process.stdin.isTTY) throw new Error("stdin_pipe_required");
  const password = await readOwnerPassword(process.stdin);
  observation.enter("connect");
  const connection = createDb(command.env.DATABASE_URL, {
    max: 1,
    connectionTimeoutMillis: 2000,
    statement_timeout: 5000,
  });
  connection.pool.on("error", () => {});
  try {
    observation.enter("database_identity");
    const identity = await connection.pool.query<{ name: string; owner: string }>(
      "SELECT current_database() AS name, current_user AS owner",
    );
    if (identity.rows[0]?.name !== "markiro_us_dev" || identity.rows[0]?.owner !== "markiro_us")
      throw new Error("database_identity_mismatch");
    observation.enter("store");
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
    observation.enter("result_output");
    console.log(JSON.stringify(result));
  } catch (error) {
    observation.fail();
    throw error;
  } finally {
    observation.enter("pool_close");
    let poolClosed = false;
    try {
      await connection.pool.end();
      poolClosed = true;
    } finally {
      if (!poolClosed) observation.closeFailed();
    }
  }
}

void main().catch(() => {
  observation.fail();
  // Driver, configuration and password errors must never escape into logs.
  console.error(
    "US synthetic viewer command refused. Check exact arguments, isolated migrated database, trusted owner/profile and password input. Existing identities are never repaired or reset.",
  );
  process.exitCode = 1;
  observation.emitFailure((line) => console.error(line));
});
