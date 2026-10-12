import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  cleanRuntimeEnv,
  createValidationEnv,
  validateBaseUrl,
  validationArgs,
} from "./api-validation-env.mjs";

// The synthetic administrative entry point is the tracked us-development.yml fixture.
// No caller-supplied URL is ever accepted as a migration or business-write target.
const base = "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev";
const root = fileURLToPath(new URL("../../", import.meta.url));
const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const secrets = {
  auth: randomBytes(32).toString("hex"),
  platform: randomBytes(32).toString("hex"),
  pepper: randomBytes(32).toString("hex"),
  chz: randomBytes(32).toString("base64"),
  mail: randomBytes(32).toString("base64"),
};
const redact = (value) =>
  [base, new URL(base).password, ...Object.values(secrets)].reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    String(value),
  );

/** Keep handlers active through acquisition, migration, subprocess exit and disposal. */
export async function withDeferredSignals(operation) {
  let signal;
  let activeChild;
  const onSignal = (received) => {
    signal ??= received;
    activeChild?.kill(received);
  };
  const interrupt = () => onSignal("SIGINT");
  const terminate = () => onSignal("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const code = await operation({
      checkpoint() {
        if (signal)
          throw Object.assign(new Error(`API validation interrupted by ${signal}`), {
            validationExitCode: signal === "SIGINT" ? 130 : 143,
          });
      },
      trackChild(child) {
        activeChild = child;
        if (signal) activeChild?.kill(signal);
      },
    });
    return code || (signal ? (signal === "SIGINT" ? 130 : 143) : 0);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function runTests(args, env, lifecycle) {
  const executable = join(dirname(apiRequire.resolve("vitest/package.json")), "vitest.mjs");
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: join(root, "apps/api"),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Redact complete lines so stream chunk boundaries cannot expose generated keys.
  const output = [child.stdout, child.stderr].map((stream) => {
    const lines = createInterface({ input: stream });
    lines.on("line", (line) => console.log(redact(line)));
    return new Promise((resolve) => lines.on("close", resolve));
  });
  lifecycle.trackChild(child);
  try {
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 143)));
    });
    await Promise.all(output);
    console.log(`API validation subprocess exited: ${code}`);
    return code;
  } finally {
    lifecycle.trackChild(undefined);
  }
}

async function main(lifecycle) {
  const args = validationArgs(process.argv.slice(2));
  validateBaseUrl(base);
  // pg reads PGOPTIONS/PGSSLMODE and other ambient settings in the parent too.
  // Sanitize this process before loading its driver, not only the Vitest child.
  const runtime = cleanRuntimeEnv(process.env);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, runtime);
  const { createDb } = apiRequire("@markiro/db");
  const { migrate } = apiRequire("drizzle-orm/node-postgres/migrator");
  const name = `markiro_us_api_${randomUUID().replaceAll("-", "_")}`;
  let refused = 0;
  const services = createServer((socket) => {
    refused += 1;
    socket.destroy();
  });
  const admin = createDb(base);
  let databaseNames;
  let scratch;
  let created = false;
  let failure;
  let exitCode = 0;
  try {
    await new Promise((resolve, reject) => {
      services.once("error", reject);
      services.listen(0, "127.0.0.1", resolve);
    });
    lifecycle.checkpoint();
    const env = createValidationEnv(base, name, secrets, process.env, services.address());
    const identity = await admin.pool.query(
      "SELECT current_database() AS name, current_user AS owner",
    );
    if (identity.rows[0]?.name !== "markiro_us_dev" || identity.rows[0]?.owner !== "markiro_us")
      throw new Error("API validation administrative identity mismatch");
    console.log("Administrative identity verified: 127.0.0.1:55432 / markiro_us_dev / markiro_us");
    databaseNames = new Set(
      (await admin.pool.query("SELECT datname FROM pg_database")).rows.map((row) => row.datname),
    );
    console.log(`Owned SMTP/storage refusal listener: 127.0.0.1:${services.address().port}`);
    lifecycle.checkpoint();
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    created = true;
    console.log(`Created invocation-owned database: ${name}`);
    lifecycle.checkpoint();
    scratch = createDb(env.DATABASE_URL);
    const childIdentity = await scratch.pool.query(
      "SELECT current_database() AS name, current_user AS owner",
    );
    if (childIdentity.rows[0]?.name !== name || childIdentity.rows[0]?.owner !== "markiro_us")
      throw new Error("API validation child identity mismatch");
    await migrate(scratch.db, { migrationsFolder: join(root, "packages/db/migrations") });
    const journal = await scratch.pool.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    console.log(
      `Migrated owned child: ${journal.rows[0].count} migrations; US_TEST_DATABASE_URL unset`,
    );
    await scratch.pool.end();
    scratch = undefined;
    lifecycle.checkpoint();
    exitCode = await runTests(args, env, lifecycle);
  } catch (error) {
    failure = error;
    exitCode = error.validationExitCode ?? 1;
  } finally {
    // The subprocess has exited before disposal. Never force-drop or terminate sessions.
    try {
      await scratch?.pool.end();
      if (created) {
        await admin.pool.query(`DROP DATABASE "${name}"`);
        const absent = await admin.pool.query(
          "SELECT datname FROM pg_database WHERE datname = $1",
          [name],
        );
        if (absent.rows.length !== 0) {
          console.error("API validation child disposal could not be verified");
          exitCode ||= 1;
        } else {
          console.log(`Normal DROP verified after owned work drained: ${name}`);
        }
        const remaining = (await admin.pool.query("SELECT datname FROM pg_database")).rows.filter(
          (row) => !databaseNames.has(row.datname),
        );
        console.log(`New databases remaining after suite cleanup: ${remaining.length}`);
        if (remaining.length) {
          console.error(
            "Additional databases appeared during validation; retained for ownership review",
          );
          exitCode ||= 1;
        }
      }
    } catch (error) {
      console.error(`API validation cleanup failed: ${redact(error.message)}`);
      exitCode ||= 1;
    } finally {
      try {
        await admin.pool.end();
      } catch (error) {
        console.error(`Administrative pool cleanup failed: ${redact(error.message)}`);
        exitCode ||= 1;
      }
      await new Promise((resolve) => services.close(resolve));
      console.log(`Owned service listener closed; refused connections: ${refused}`);
    }
  }
  if (failure) console.error(`API validation failed: ${redact(failure.message)}`);
  return exitCode;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await withDeferredSignals(main);
  } catch (error) {
    console.error(redact(error.message));
    process.exitCode = 1;
  }
}
