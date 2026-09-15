import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { isMainModule } from "./cli-main.mjs";
import {
  authenticatedKnownHosts,
  publicIpv4,
  runCommand,
  validateHostedPrivateKey,
} from "./remote-deploy.mjs";

const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const MAX_RESPONSE_BYTES = 1024;
const JOURNAL_STATES = Object.freeze(["before_0157", "partial", "through_0161"]);
const BINARY_STATES = Object.freeze(["installed", "missing"]);
const SCHEMA_STATES = Object.freeze(["ready", "partial", "missing"]);
const CONSTRAINT_STATES = Object.freeze(["validated", "unvalidated", "missing"]);

const DATABASE_PROBE = String.raw`
import pg from "/app/node_modules/.pnpm/node_modules/pg/esm/index.mjs";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 15000,
  max: 1,
});

try {
  const extension = await pool.query(
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') AS present",
  );
  const journal = await pool.query(
    "SELECT COALESCE(MAX(created_at), 0)::text AS latest FROM drizzle.__drizzle_migrations",
  );
  const tables = await pool.query(
    "SELECT to_regclass('public.service_periods') IS NOT NULL AS periods, to_regclass('public.service_usage_entries') IS NOT NULL AS usage, to_regclass('public.service_excess_approvals') IS NOT NULL AS approvals, to_regclass('public.billing_act_service_usage') IS NOT NULL AS acts",
  );
  const constraints = await pool.query(
    "SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[])",
    [[
      "catalog_item_versions_kind_billing_check",
      "commercial_offer_lines_commercial_terms_check",
      "invoice_lines_commercial_terms_check",
      "service_periods_no_overlap",
    ]],
  );
  const latest = Number(journal.rows[0]?.latest ?? 0);
  const tableValues = Object.values(tables.rows[0] ?? {});
  const expectedConstraints = 4;
  const evidence = {
    version: 1,
    journal: latest >= 1789425212153 ? "through_0161" : latest >= 1789415316089 ? "partial" : "before_0157",
    btreeGist: extension.rows[0]?.present === true ? "installed" : "missing",
    schema: tableValues.length === 4 && tableValues.every(Boolean) ? "ready" : tableValues.some(Boolean) ? "partial" : "missing",
    constraints: constraints.rows.length !== expectedConstraints ? "missing" : constraints.rows.every((row) => row.convalidated === true) ? "validated" : "unvalidated",
  };
  process.stdout.write("MARKIRO_RECURRING_SERVICES_DIAGNOSTICS " + JSON.stringify(evidence) + "\n");
} finally {
  await pool.end();
}
`;

function invalidResponse() {
  return new Error("recurring-services diagnostic response is invalid");
}

function requiredEnvironment(name, environment) {
  const value = environment[name];
  if (!value) throw invalidResponse();
  return value;
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(",") === keys
  );
}

export function parseRecurringServicesEvidence(output) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_RESPONSE_BYTES)
    throw invalidResponse();
  const match = output.match(/^MARKIRO_RECURRING_SERVICES_DIAGNOSTICS (\{[^\n]+\})\n$/);
  if (!match) throw invalidResponse();
  let value;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw invalidResponse();
  }
  if (
    !exactKeys(value, "btreeGist,constraints,journal,schema,version") ||
    value.version !== 1 ||
    !JOURNAL_STATES.includes(value.journal) ||
    !BINARY_STATES.includes(value.btreeGist) ||
    !SCHEMA_STATES.includes(value.schema) ||
    !CONSTRAINT_STATES.includes(value.constraints)
  )
    throw invalidResponse();
  return value;
}

function parseContainer(output) {
  const match = typeof output === "string" ? output.match(/^([0-9a-f]{12,64})\n$/) : null;
  if (!match || !CONTAINER_ID.test(match[1])) throw invalidResponse();
  return match[1];
}

export async function runHostedRecurringServicesDiagnostics(
  environment = process.env,
  supplied = {},
) {
  const system = {
    mkdtemp,
    writeFile,
    rm,
    validatePrivateKey: (path) => validateHostedPrivateKey(path, { readFile, stat }),
    run: (command, args, options) => runCommand(command, args, options),
    ...supplied,
  };
  const address = publicIpv4(requiredEnvironment("YC_APP_PUBLIC_ADDRESS", environment));
  const login = requiredEnvironment("YC_APP_DEPLOY_LOGIN", environment);
  if (login !== "markiro-deploy") throw invalidResponse();
  const identity = requiredEnvironment("YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH", environment);
  const knownHosts = authenticatedKnownHosts(
    requiredEnvironment("APP_SSH_HOST_KEYS_B64", environment),
    address,
  );
  await system.validatePrivateKey(identity);
  const directory = await system.mkdtemp(join(tmpdir(), "markiro-recurring-services-diagnostics-"));
  let result;
  let failure;
  try {
    const knownHostsPath = join(directory, "known_hosts");
    await system.writeFile(knownHostsPath, knownHosts, { encoding: "utf8", mode: 0o600 });
    const sshBase = [
      "-F",
      "/dev/null",
      "-i",
      identity,
      "-o",
      `UserKnownHostsFile=${knownHostsPath}`,
      "-o",
      "GlobalKnownHostsFile=/dev/null",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      `${login}@${address}`,
    ];
    const container = parseContainer(
      await system.run("ssh", [
        ...sshBase,
        "sudo",
        "/usr/local/bin/docker",
        "ps",
        "-q",
        "--filter",
        "label=com.docker.compose.project=markiro-production",
        "--filter",
        "label=com.docker.compose.service=api",
      ]),
    );
    result = parseRecurringServicesEvidence(
      await system.run(
        "ssh",
        [
          ...sshBase,
          "sudo",
          "/usr/local/bin/docker",
          "exec",
          "-i",
          "-w",
          "/app",
          container,
          "node",
          "--input-type=module",
          "-",
        ],
        { input: DATABASE_PROBE },
      ),
    );
  } catch (error) {
    failure = error;
  }
  let cleanupFailure;
  try {
    await system.rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}

export async function runRecurringServicesDiagnosticsCli(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const argv = options.argv ?? process.argv.slice(2);
    if (argv.length !== 1 || argv[0] !== "run") throw invalidResponse();
    const evidence = await (options.runDiagnostics ?? runHostedRecurringServicesDiagnostics)(
      options.environment ?? process.env,
      options.supplied ?? {},
    );
    stdout.write(`MARKIRO_RECURRING_SERVICES_DIAGNOSTICS ${JSON.stringify(evidence)}\n`);
    return 0;
  } catch {
    stderr.write("MARKIRO_RECURRING_SERVICES_DIAGNOSTICS_FAILURE\n");
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = await runRecurringServicesDiagnosticsCli();
}
