import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { verifyCasesFixture, runCasesFixtureCli } from "../verify-cases-fixture.mjs";

const fixture = "postgres://markiro_us:synthetic@127.0.0.1:55432/markiro_us_dev";
const env = { US_TEST_DATABASE_URL: fixture };
const makeClient = (
  answers = [
    { rows: [{ name: "markiro_us_dev", owner: "markiro_us" }] },
    { rows: [{ count: "0" }] },
    { rows: [{ count: "0" }] },
    { rows: [{ count: "0" }] },
  ],
) => {
  const calls = { configs: [], sql: [], connect: 0, end: 0 };
  const client = {
    async connect() {
      calls.connect++;
    },
    async query(sql) {
      calls.sql.push(sql);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    async end() {
      calls.end++;
    },
  };
  return {
    calls,
    client,
    createClient: (config) => {
      calls.configs.push(config);
      return client;
    },
  };
};

test("zero census checks actual identity, three read-only counts and closes once", async () => {
  const fake = makeClient();
  const result = await verifyCasesFixture({ env, createClient: fake.createClient });
  assert.deepEqual(result, {
    database: "markiro_us_dev",
    user: "markiro_us",
    publicTables: 0,
    profileChildren: 0,
    otherClients: 0,
  });
  assert.equal(fake.calls.connect, 1);
  assert.equal(fake.calls.end, 1);
  assert.equal(fake.calls.sql.length, 4);
  assert.ok(fake.calls.sql.every((sql) => /^SELECT\b/i.test(sql)));
  assert.match(fake.calls.sql[2], /markiro_us_profile_/);
  assert.match(fake.calls.sql[3], /backend_type = 'client backend'/);
  assert.match(fake.calls.sql[3], /pg_backend_pid\(\)/);
  assert.deepEqual(fake.calls.configs[0], {
    host: "127.0.0.1",
    port: 55432,
    database: "markiro_us_dev",
    user: "markiro_us",
    password: "synthetic",
    ssl: false,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
});

test("unsafe URL or driver inheritance rejects before construction", async (t) => {
  for (const [name, input, inherited] of [
    ["missing URL", {}, {}],
    ["primary URL", { ...env, DATABASE_URL: "secret" }, {}],
    ["remote", { US_TEST_DATABASE_URL: fixture.replace("127.0.0.1", "remote.example") }, {}],
    ["wrong port", { US_TEST_DATABASE_URL: fixture.replace("55432", "5432") }, {}],
    ["wrong database", { US_TEST_DATABASE_URL: fixture.replace("markiro_us_dev", "other") }, {}],
    ["query options", { US_TEST_DATABASE_URL: `${fixture}?options=secret` }, {}],
    ["missing credential", { US_TEST_DATABASE_URL: fixture.replace("synthetic@", "@") }, {}],
    ["supplied PGOPTIONS", { ...env, PGOPTIONS: "-c search_path=other" }, {}],
    ["ambient PGSSLMODE", env, { PGSSLMODE: "require" }],
    ["ambient PGSSLNEGOTIATION", env, { PGSSLNEGOTIATION: "direct" }],
  ])
    await t.test(name, async () => {
      const fake = makeClient();
      await assert.rejects(
        verifyCasesFixture({ env: input, processEnv: inherited, createClient: fake.createClient }),
      );
      assert.equal(fake.calls.configs.length, 0);
    });
});

test("mismatch, residue, connect and query failures still close own client", async (t) => {
  for (const [name, answers] of [
    ["database mismatch", [{ rows: [{ name: "other", owner: "markiro_us" }] }]],
    ["user mismatch", [{ rows: [{ name: "markiro_us_dev", owner: "other" }] }]],
    [
      "public tables",
      [{ rows: [{ name: "markiro_us_dev", owner: "markiro_us" }] }, { rows: [{ count: "1" }] }],
    ],
    [
      "child database",
      [
        { rows: [{ name: "markiro_us_dev", owner: "markiro_us" }] },
        { rows: [{ count: "0" }] },
        { rows: [{ count: "1" }] },
      ],
    ],
    [
      "other client",
      [
        { rows: [{ name: "markiro_us_dev", owner: "markiro_us" }] },
        { rows: [{ count: "0" }] },
        { rows: [{ count: "0" }] },
        { rows: [{ count: "1" }] },
      ],
    ],
    ["query failure", [new Error("query failed")]],
  ])
    await t.test(name, async () => {
      const fake = makeClient(answers);
      await assert.rejects(verifyCasesFixture({ env, createClient: fake.createClient }));
      assert.equal(fake.calls.end, 1);
    });
  const fake = makeClient();
  fake.client.connect = async () => {
    throw new Error("connect failed");
  };
  await assert.rejects(
    verifyCasesFixture({ env, createClient: fake.createClient }),
    /connect failed/,
  );
  assert.equal(fake.calls.end, 1);
});

test("probe plus disposal failures preserve both; end deadline fails terminal CLI seam", async () => {
  const fake = makeClient([new Error("probe failed")]);
  fake.client.end = async () => {
    fake.calls.end++;
    throw new Error("end failed");
  };
  await assert.rejects(verifyCasesFixture({ env, createClient: fake.createClient }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    return true;
  });
  const hanging = makeClient();
  hanging.client.end = () => {
    hanging.calls.end++;
    return new Promise(() => {});
  };
  const exits = [];
  const diagnostics = [];
  await runCasesFixtureCli({
    env,
    createClient: hanging.createClient,
    deadlineMs: 5,
    exit: (code) => exits.push(code),
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.deepEqual(exits, [1]);
  const rejected = makeClient();
  rejected.client.end = async () => {
    rejected.calls.end++;
    throw new Error("private end detail");
  };
  await runCasesFixtureCli({
    env,
    createClient: rejected.createClient,
    exit: (code) => exits.push(code),
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.deepEqual(exits, [1, 1]);
  assert.ok(diagnostics.every((message) => !message.includes("private end detail")));
  const late = makeClient();
  late.client.end = () => {
    late.calls.end++;
    return new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 15));
  };
  await runCasesFixtureCli({
    env,
    createClient: late.createClient,
    deadlineMs: 5,
    exit: (code) => exits.push(code),
    diagnostic: (message) => diagnostics.push(message),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(exits, [1, 1, 1]);
  assert.equal(late.calls.end, 1);
  assert.equal(hanging.calls.end, 1);
  assert.match(diagnostics[0], /normal disposal not confirmed/i);
  const good = makeClient();
  await runCasesFixtureCli({
    env,
    createClient: good.createClient,
    exit: (code) => exits.push(code),
    diagnostic: (message) => diagnostics.push(message),
  });
  assert.deepEqual(exits, [1, 1, 1]);
});

test("installed pg resolves from declared DB dependency and receives isolated parameters", async () => {
  const require = createRequire(new URL("../../../packages/db/package.json", import.meta.url));
  const { Client } = require("pg");
  assert.equal(typeof Client, "function");
  const fake = makeClient();
  let parameters;
  await verifyCasesFixture({
    env,
    createClient: (config) => {
      parameters = new Client(config).connectionParameters;
      return fake.createClient(config);
    },
  });
  assert.equal(parameters.host, "127.0.0.1");
  assert.equal(parameters.port, 55432);
  assert.equal(parameters.database, "markiro_us_dev");
  assert.equal(parameters.user, "markiro_us");
  assert.equal(parameters.password, "synthetic");
  assert.equal(parameters.ssl, false);
  assert.ok(!parameters.options);
  assert.notEqual(parameters.sslnegotiation, "direct");
});

test("hostile actual PostgreSQL process settings are rejected before pg construction", () => {
  const moduleUrl = new URL("../verify-cases-fixture.mjs", import.meta.url).href;
  const script = `
    const {verifyCasesFixture} = await import(${JSON.stringify(moduleUrl)});
    let constructed = 0;
    try {
      await verifyCasesFixture({env: {US_TEST_DATABASE_URL: ${JSON.stringify(fixture)}}, createClient: () => {constructed++; throw Error('constructed');}});
      process.exitCode = 2;
    } catch (error) {
      console.log(JSON.stringify({constructed, message: error.message}));
    }
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      PGOPTIONS: "-c search_path=other",
      PGSSLMODE: "require",
      PGSSLNEGOTIATION: "direct",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    constructed: 0,
    message: "Cases fixture rejects inherited PostgreSQL driver settings",
  });
});
