import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const deadlineMs = 5000;
const dbRequire = createRequire(new URL("../../packages/db/package.json", import.meta.url));

class DisposalError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "DisposalError";
  }
}

function fixtureUrl(env, processEnv) {
  if (env.DATABASE_URL || processEnv.DATABASE_URL || process.env.DATABASE_URL)
    throw new Error("Cases fixture rejects primary DATABASE_URL");
  for (const source of [env, processEnv, process.env]) {
    if (Object.keys(source).some((key) => /^PG[A-Z0-9_]*$/.test(key)))
      throw new Error("Cases fixture rejects inherited PostgreSQL driver settings");
  }
  const raw = env.US_TEST_DATABASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Cases fixture requires explicit isolated URL");
  }
  if (
    typeof raw !== "string" ||
    raw !== url.toString() ||
    url.protocol !== "postgres:" ||
    url.hostname !== "127.0.0.1" ||
    url.port !== "55432" ||
    url.pathname !== "/markiro_us_dev" ||
    url.username !== "markiro_us" ||
    !url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Cases fixture requires explicit isolated URL");
  return url;
}

async function endWithin(client, timeoutMs) {
  let timer;
  try {
    // Promise.race observes a late rejection from end() after the bound fires.
    await Promise.race([
      Promise.resolve().then(() => client.end()),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new DisposalError("normal disposal not confirmed")),
          timeoutMs,
        );
      }),
    ]);
  } catch (cause) {
    if (cause instanceof DisposalError) throw cause;
    throw new DisposalError("normal disposal not confirmed", { cause });
  } finally {
    clearTimeout(timer);
  }
}

/** Read-only census of the single synthetic Cases fixture. */
export async function verifyCasesFixture({
  env,
  createClient,
  processEnv = process.env,
  deadlineMs: endDeadlineMs = deadlineMs,
}) {
  const url = fixtureUrl(env, processEnv);
  const client = createClient({
    host: url.hostname,
    port: Number(url.port),
    database: url.pathname.slice(1),
    user: url.username,
    password: decodeURIComponent(url.password),
    ssl: false,
    connectionTimeoutMillis: deadlineMs,
    query_timeout: deadlineMs,
    statement_timeout: deadlineMs,
  });
  let failure;
  let result;
  try {
    await client.connect();
    const identity = await client.query("SELECT current_database() AS name, current_user AS owner");
    if (
      identity.rows[0]?.name !== url.pathname.slice(1) ||
      identity.rows[0]?.owner !== url.username
    )
      throw new Error("Cases fixture actual target identity mismatch");
    const publicTables = Number(
      (
        await client.query(
          "SELECT count(*) AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')",
        )
      ).rows[0]?.count,
    );
    const profileChildren = Number(
      (
        await client.query(
          "SELECT count(*) AS count FROM pg_database WHERE left(datname, length('markiro_us_profile_')) = 'markiro_us_profile_'",
        )
      ).rows[0]?.count,
    );
    const otherClients = Number(
      (
        await client.query(
          "SELECT count(*) AS count FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()",
        )
      ).rows[0]?.count,
    );
    if (
      ![publicTables, profileChildren, otherClients].every(
        (count) => Number.isSafeInteger(count) && count === 0,
      )
    )
      throw new Error("Cases fixture catalog is not empty");
    result = {
      database: url.pathname.slice(1),
      user: url.username,
      publicTables,
      profileChildren,
      otherClients,
    };
  } catch (error) {
    failure = error;
  }
  try {
    await endWithin(client, endDeadlineMs);
  } catch (endError) {
    if (failure)
      throw new AggregateError(
        [failure, endError],
        "Cases fixture probe and normal disposal failed",
      );
    throw endError;
  }
  if (failure) throw failure;
  return result;
}

export async function runCasesFixtureCli({
  env = process.env,
  createClient = (config) => new (dbRequire("pg").Client)(config),
  processEnv = process.env,
  deadlineMs: endDeadlineMs = deadlineMs,
  diagnostic = (message) => console.error(message),
  exit = (code) => process.exit(code),
  setExitCode = (code) => {
    process.exitCode = code;
  },
} = {}) {
  try {
    const result = await verifyCasesFixture({
      env,
      createClient,
      processEnv,
      deadlineMs: endDeadlineMs,
    });
    console.log(
      `Cases fixture: ${result.database}/${result.user}; public tables ${result.publicTables}, profile children ${result.profileChildren}, other clients ${result.otherClients}`,
    );
  } catch (error) {
    const disposalFailed =
      error instanceof DisposalError ||
      (error instanceof AggregateError &&
        error.errors.some((item) => item instanceof DisposalError));
    diagnostic(
      disposalFailed
        ? "Cases fixture failed; normal disposal not confirmed"
        : "Cases fixture validation failed",
    );
    if (disposalFailed) exit(1);
    else setExitCode(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await runCasesFixtureCli();
