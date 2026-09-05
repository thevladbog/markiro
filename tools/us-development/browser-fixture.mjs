import { randomUUID, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { createUsAdminConfig } from "../../apps/admin/vite.us.config.ts";
import { createUsProfileTestDatabase } from "../../apps/api/test/support/us-profile-database.ts";

const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const adminRequire = createRequire(new URL("../../apps/admin/package.json", import.meta.url));
apiRequire("reflect-metadata");
const { createDb } = apiRequire("@markiro/db");
const { createUsDevelopmentApplication } = apiRequire("./dist/deployment/us-bootstrap.js");
const { UsDevelopmentOwnerStore } = apiRequire("./dist/deployment/us-development-owner.js");

/** Owns only a randomly created test database and new loopback listeners.
 * This is not a provisioning/deployment command and is never imported by an app.
 */
export async function startUsBrowserFixture(base) {
  if (!base) throw new Error("Explicit US_TEST_DATABASE_URL is required for browser verification");
  const previousCwd = process.cwd();
  let fixture;
  try {
    // The established fixture resolves the migration chain relative to apps/api.
    process.chdir(fileURLToPath(new URL("../../apps/api", import.meta.url)));
    fixture = await createUsProfileTestDatabase(base);
  } finally {
    process.chdir(previousCwd);
  }
  let app;
  let server;
  try {
    const identity = await fixture.pool.query("SELECT current_database() AS name");
    const scratchUrl = new URL(base);
    scratchUrl.pathname = `/${identity.rows[0].name}`;
    const password = `Synthetic-${randomBytes(24).toString("hex")}`;
    const owner = await new UsDevelopmentOwnerStore(fixture.db).provision(password, randomUUID());
    const env = parseEnv(
      readFileSync(
        new URL("../../deploy/us-development/local.env.example", import.meta.url),
        "utf8",
      ),
    );
    app = await createUsDevelopmentApplication(env, () => createDb(scratchUrl.toString()));
    await app.listen(3100, "127.0.0.1");
    const { createServer } = await import(adminRequire.resolve("vite"));
    server = await createServer({
      ...createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test"),
      configFile: false,
      mode: "test",
      logLevel: "silent",
    });
    await server.listen();
    return {
      email: owner.email,
      password,
      tenantId: owner.tenantId,
      userId: owner.userId,
      pool: fixture.pool,
      async close() {
        try {
          await server.close();
        } finally {
          try {
            await app.close();
          } finally {
            await fixture.close();
          }
        }
      },
    };
  } catch {
    try {
      await server?.close();
    } finally {
      try {
        await app?.close();
      } finally {
        await fixture.close();
      }
    }
    // Raw driver/library failures can contain password material.
    throw new Error(
      "US browser fixture could not start; check local builds, ports and test database",
    );
  }
}
