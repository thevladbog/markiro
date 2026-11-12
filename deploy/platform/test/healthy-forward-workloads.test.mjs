import assert from "node:assert/strict";
import test from "node:test";
import { createHealthyForwardWorkloads } from "../host/healthy-forward-workloads.mjs";

const root = "/opt/markiro-platform/state";
const dockerConfig = `${root}/docker`;
const docker = ["--host", "unix:///var/run/docker.sock"];
const compose = [
  ...docker,
  "compose",
  "--project-name",
  "markiro-platform",
  ...["compose.yml", "compose.compact.yml", "compose.catalog.yml"].flatMap((file) => [
    "--file",
    `/opt/markiro-platform/upgrade-bootstrap/${"a".repeat(40)}/deploy/platform/${file}`,
  ]),
];
const environment = { DOCKER_CONFIG: dockerConfig, COMPOSE_DISABLE_ENV_FILE: "1" };
const description = (digit) => ({
  id: digit.repeat(64),
  imageId: `sha256:${digit.repeat(64)}`,
  recipeSha256: digit.repeat(64),
});
const source = { api: description("1"), edge: description("2"), postgres: description("3") };
const selected = { api: description("4"), edge: description("5") };

function fixture() {
  let phase = "source-healthy";
  const commands = [];
  const order = [];
  const scenario = {
    postgresId: source.postgres.id,
    failStop: false,
    swapPostgresAfterEdgeStop: false,
    refuseMutation: null,
  };
  const runProcess = async ({ executable, args, cwd, env }) => {
    assert.equal(executable, "/usr/bin/docker");
    assert.equal(cwd, root);
    assert.equal(env.DOCKER_CONFIG, dockerConfig);
    assert.deepEqual(args.slice(0, 2), docker);
    if (args[2] === "container" && args[3] === "ls") {
      const service = args.at(-1).split("=").at(-1);
      return { stdout: Buffer.from(`${selected[service].id}\n`) };
    }
    commands.push(args);
    if (args[2] === "container") {
      order.push(`stop ${args.at(-1) === source.edge.id ? "edge" : "api"}`);
      if (scenario.failStop)
        throw Object.assign(new Error("stop timed out"), { terminationConfirmed: false });
      phase = args.at(-1) === source.edge.id ? "source-edge-stopped" : "source-stopped";
      if (phase === "source-edge-stopped" && scenario.swapPostgresAfterEdgeStop)
        scenario.postgresId = "6".repeat(64);
    } else {
      order.push(`up ${args.at(-1)}`);
      assert.deepEqual(env, environment);
      phase = args.at(-1) === "api" ? "api-started" : "edge-started";
    }
    return { stdout: Buffer.alloc(0) };
  };
  const commandsAdapter = createHealthyForwardWorkloads(
    { root, dockerConfig, sourceContainers: source },
    {
      candidate: {
        composePrefix: compose,
        environment,
        verifyCompose: async () => {
          order.push("compose verified");
        },
        observe: async (service, id) => {
          assert.equal(id, selected[service].id);
          return selected[service];
        },
      },
      observe: async (workload) => {
        order.push(`observe ${workload.phase}`);
        assert.equal(workload.phase, phase);
        return {
          containers: {
            ...source,
            ...workload.candidateContainers,
            postgres: { ...source.postgres, id: scenario.postgresId },
          },
        };
      },
      verifyAuthority: async () => {},
      verifyMutation: async (entered) => {
        order.push(`approve ${entered}`);
        if (scenario.refuseMutation === entered) throw new Error("journal authority changed");
      },
      runProcess,
    },
  );
  return { commandsAdapter, commands, order, scenario };
}

test("workload commands stop exact old IDs and replace API then edge without touching Postgres", async () => {
  const { commandsAdapter, commands, order } = fixture();
  await commandsAdapter.stopSource();
  await commandsAdapter.verifySourceStopped();
  const api = await commandsAdapter.activateApi();
  const edge = await commandsAdapter.activateEdge(api);
  const expected = { api: selected.api.id, edge: selected.edge.id, postgres: source.postgres.id };
  assert.deepEqual(await commandsAdapter.verifyWorkloads(expected), expected);
  assert.deepEqual(commands, [
    [...docker, "container", "stop", "--time", "30", source.edge.id],
    [...docker, "container", "stop", "--time", "30", source.api.id],
    [...compose, "up", "-d", "--wait", "--no-deps", "api"],
    [...compose, "up", "-d", "--no-deps", "edge"],
  ]);
  assert.ok(order.indexOf("observe source-edge-stopped") < order.indexOf("stop api"));
  for (const [entered, command] of [
    ["source-stop-entered", "stop edge"],
    ["source-stop-entered", "stop api"],
    ["api-entered", "up api"],
    ["edge-entered", "up edge"],
  ])
    assert.equal(order[order.indexOf(command) - 1], `approve ${entered}`);
});

test("a changed PostgreSQL container prevents any stop", async () => {
  const { commandsAdapter, commands, scenario } = fixture();
  scenario.postgresId = "6".repeat(64);
  await assert.rejects(commandsAdapter.stopSource());
  assert.deepEqual(commands, []);
});

test("a changed PostgreSQL container after the edge stops prevents the API stop", async () => {
  const { commandsAdapter, commands, scenario } = fixture();
  scenario.swapPostgresAfterEdgeStop = true;
  await assert.rejects(commandsAdapter.stopSource());
  assert.deepEqual(commands, [[...docker, "container", "stop", "--time", "30", source.edge.id]]);
});

test("a refused mutation guard prevents a Compose launch after the source stops", async () => {
  const { commandsAdapter, commands, scenario } = fixture();
  await commandsAdapter.stopSource();
  scenario.refuseMutation = "api-entered";
  await assert.rejects(commandsAdapter.activateApi());
  assert.equal(
    commands.some((command) => command.includes("up")),
    false,
  );
});

test("an uncertain edge stop blocks subsequent workload commands", async () => {
  const { commandsAdapter, commands, scenario } = fixture();
  scenario.failStop = true;
  await assert.rejects(commandsAdapter.stopSource(), { terminationConfirmed: false });
  scenario.failStop = false;
  await assert.rejects(commandsAdapter.stopSource());
  await assert.rejects(commandsAdapter.activateApi());
  assert.deepEqual(commands, [[...docker, "container", "stop", "--time", "30", source.edge.id]]);
});

test("edge cannot start against an unverified API container ID", async () => {
  const { commandsAdapter, commands } = fixture();
  await commandsAdapter.stopSource();
  await commandsAdapter.activateApi();
  await assert.rejects(commandsAdapter.activateEdge(source.api.id));
  assert.equal(
    commands.some((command) => command.includes("up") && command.at(-1) === "edge"),
    false,
  );
});
