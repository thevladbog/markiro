/** Trusted image entry point. Never logs SQL, credentials, child output or rows. */
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { runHostProcess } from "../host/process.mjs";
import {
  captureInventory,
  captureSequences,
  mapInventory,
  roleSql,
  ownershipSql,
  compareInventories,
} from "./inventory.mjs";
import { canonical, ensure, quote } from "./schemas.mjs";
import { noWriters } from "./source-state.mjs";
const require = createRequire(import.meta.url),
  { Client } = require("pg");
const directory = "/work",
  out = "/work/out";
const mode = process.argv[2];
let phase = "initialize",
  client;
const bin = "/usr/lib/postgresql/17/bin/";
const processRun = (name, args, env = {}) =>
  runHostProcess({
    executable: bin + name,
    args,
    cwd: directory,
    env: { PATH: bin + ":/usr/bin:/bin", LANG: "C.UTF-8", HOME: directory, ...env },
    timeoutMs: 600000,
    outputLimitBytes: 65536,
  });
async function save(name, value) {
  await writeFile(`${out}/${name}`, canonical(value) + "\n", { mode: 0o600, flag: "wx" });
}
function parseService(text) {
  const lines = text.trim().split("\n");
  ensure(lines.shift() === "[backup]");
  const fields = {};
  for (const line of lines) {
    const i = line.indexOf("=");
    ensure(i > 0 && !Object.hasOwn(fields, line.slice(0, i)));
    fields[line.slice(0, i)] = line.slice(i + 1);
  }
  ensure(
    Object.keys(fields).sort().join() ===
      ["dbname", "host", "port", "sslmode", "sslrootcert", "user"].sort().join(),
  );
  ensure(
    fields.sslmode === "verify-full" &&
      fields.sslrootcert === "/input/ca.crt" &&
      /^\d{1,5}$/u.test(fields.port),
  );
  return fields;
}
async function sourceClient(applicationName) {
  const s = parseService(await readFile("/input/service.conf", "utf8"));
  const lines = (await readFile("/input/password", "utf8")).trim().split("\n");
  ensure(lines.length === 1);
  const parts = lines[0].split(":");
  ensure(
    parts.length === 5 &&
      parts[0] === s.host &&
      parts[1] === s.port &&
      parts[2] === s.dbname &&
      parts[3] === s.user &&
      /^[a-zA-Z0-9_-]{24,}$/u.test(parts[4]),
  );
  return new Client({
    host: s.host,
    port: Number(s.port),
    database: s.dbname,
    user: s.user,
    password: parts[4],
    application_name: applicationName,
    connectionTimeoutMillis: 15000,
    statement_timeout: 600000,
    ssl: { rejectUnauthorized: true, ca: await readFile("/input/ca.crt", "utf8") },
  });
}
async function archive() {
  const request = JSON.parse(await readFile("/input/request.json", "utf8")),
    applicationName = `markiro_backup_${request.operationId}`;
  client = await sourceClient(applicationName);
  await client.connect();
  await client.query(
    "SET timezone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET bytea_output='hex'; SET extra_float_digits=3; SET search_path=pg_catalog,public;",
  );
  phase = "snapshot";
  const version = (await client.query("SHOW server_version")).rows[0].server_version;
  ensure(version.startsWith("17."));
  await noWriters(client, applicationName);
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const snapshotId = (await client.query("SELECT pg_export_snapshot() AS snapshot")).rows[0]
    .snapshot;
  ensure(/^[A-F0-9-]+$/u.test(snapshotId));
  const inventory = await captureInventory(client);
  phase = "dump";
  await writeFile("/work/out/database.dump", "", { mode: 0o600, flag: "wx" });
  await processRun(
    "pg_dump",
    [
      "--format=custom",
      "--no-password",
      "--snapshot",
      snapshotId,
      "--file",
      "/work/out/database.dump",
    ],
    {
      PGSERVICE: "backup",
      PGSERVICEFILE: "/input/service.conf",
      PGPASSFILE: "/input/password",
      PGAPPNAME: applicationName,
    },
  );
  ensure(canonical(inventory.sequences) === canonical(await captureSequences(client)));
  await noWriters(client, applicationName);
  await client.query("COMMIT");
  await save("inventory.json", { snapshotId, postgresVersion: version, inventory });
}
async function restore() {
  const request = JSON.parse(await readFile("/input/request.json", "utf8"));
  const expected = mapInventory(request.inventory, request.roleMapping);
  phase = "roles";
  client = new Client({
    host: "/work/socket",
    user: "restore_admin",
    database: "postgres",
    connectionTimeoutMillis: 15000,
    statement_timeout: 600000,
  });
  await client.connect();
  await client.query(
    "SET timezone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET bytea_output='hex'; SET extra_float_digits=3; SET search_path=pg_catalog,public;",
  );
  await client.query(roleSql(expected));
  const database = expected.objects.find((o) => o.kind === "DATABASE");
  ensure(database);
  const locale = database.locale;
  ensure(
    locale?.provider === "c" &&
      [locale.encoding, locale.collate, locale.ctype].every(
        (v) => typeof v === "string" && /^[A-Za-z0-9_.@-]+$/u.test(v),
      ),
  );
  await client.query(
    `CREATE DATABASE ${quote(database.name)} OWNER ${quote(database.owner)} TEMPLATE template0 ENCODING '${locale.encoding}' LC_COLLATE '${locale.collate}' LC_CTYPE '${locale.ctype}' LOCALE_PROVIDER libc`,
  );
  await client.end();
  client = new Client({
    host: "/work/socket",
    user: "restore_admin",
    database: database.name,
    connectionTimeoutMillis: 15000,
    statement_timeout: 600000,
  });
  await client.connect();
  await client.query(
    "SET timezone='UTC'; SET DateStyle='ISO,YMD'; SET IntervalStyle='postgres'; SET bytea_output='hex'; SET extra_float_digits=3; SET search_path=pg_catalog,public;",
  );
  // Extension-created objects must have their expected mapped owner. Only the
  // currently required trusted extension is admitted; no arbitrary package load.
  for (const ext of expected.extensions) {
    ensure(ext.name === "btree_gist");
    await client.query(`GRANT CREATE ON DATABASE ${quote(database.name)} TO ${quote(ext.owner)}`);
    await client.query(`SET ROLE ${quote(ext.owner)}`);
    await client.query(`CREATE EXTENSION ${quote(ext.name)} WITH SCHEMA ${quote(ext.schema)}`);
    await client.query("RESET ROLE");
    await client.query(
      `REVOKE CREATE ON DATABASE ${quote(database.name)} FROM ${quote(ext.owner)}`,
    );
  }
  phase = "restore";
  await processRun("pg_restore", [
    "--exit-on-error",
    "--no-owner",
    "--no-acl",
    "--no-password",
    "--host",
    "/work/socket",
    "--username",
    "restore_admin",
    "--dbname",
    database.name,
    "/input/database.dump",
  ]);
  phase = "ownership";
  const ownershipStatements = ownershipSql(expected).split("\n");
  for (const [index, statement] of ownershipStatements.entries()) {
    phase = `ownership-${index}`;
    try {
      await client.query(statement);
    } catch (error) {
      for (const kind of ["schema", "function", "table", "sequence", "type", "database"])
        if (error.message?.includes(`permission denied for ${kind}`))
          phase += `-permission-${kind}`;
      throw error;
    }
  }
  phase = "inventory-capture";
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const actual = await captureInventory(client, { excludeRole: "restore_admin" });
  phase = "inventory-compare";
  const version = (await client.query("SHOW server_version")).rows[0].server_version;
  ensure(version.startsWith("17."));
  await client.query("COMMIT");
  await save("restored.json", { postgresVersion: version, inventory: actual });
  compareInventories(expected, actual);
  await client.end();
  client = undefined;
}
try {
  ensure(["archive", "restore", "restore-init"].includes(mode));
  await chmod(directory, 0o700);
  if (mode === "restore-init") {
    await processRun("initdb", [
      "-D",
      "/work/pgdata",
      "-U",
      "restore_admin",
      "--auth-local=trust",
      "--auth-host=reject",
      "--no-locale",
      "--encoding=UTF8",
    ]);
    await mkdir("/work/socket", { mode: 0o700 });
  } else {
    await mkdir(out, { mode: 0o700 });
    if (mode === "archive") await archive();
    else await restore();
  }
} catch (error) {
  if (/^inventory-[a-zA-Z-]+$/u.test(error.stage ?? "")) phase = error.stage.toLowerCase();
  const code = /^[A-Z0-9_]{1,40}$/u.test(error.code ?? "") ? error.code : "UNKNOWN";
  await save("failure.json", { stage: phase, code }).catch(() => {});
  process.stderr.write(`Backup worker failed at ${phase}; code=${code}.\n`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => {});
}
