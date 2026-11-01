import assert from "node:assert/strict";
import { test } from "node:test";
import {
  administrativePreflightProfiles,
  parseAdministrativePreflightProfile,
  assertAdministrativeFixtureOwner,
  assertAdministrativeHolderSettled,
  parseAdministrativePackageLocator,
  closeAdministrativeHolder,
  acquireAdministrativeFixtureResources,
  createAdministrativeHolder,
  createAdministrativePostgres,
  assertAdministrativePostgresNetwork,
  waitForAdministrativePostgres,
  closeAdministrativePostgres,
  administrativePostgresReadyProgram,
  administrativePostgresCredentialAwk,
  administrativePostgresSettlementProgram,
  verifyAdministrativeFileInventory,
  verifyAdministrativeFixturePackage,
  prepareAdministrativeTopology,
  prepareAdministrativeRegressionTopology,
  assertAdministrativeNativeReport,
  administrativeLocalPreflight,
  closeAdministrativeTopology,
  inspectAdministrativeTopology,
  administrativePreflightSourcePaths,
  administrativePkiSpecification,
  administrativeRegressionPkiSpecification,
  administrativeRegressionPkiMaterial,
  administrativeRegressionRuntimeConfiguration,
  administrativeRegressionPackageProgram,
  administrativeRegressionMaterialProgram,
  administrativePkiMaterial,
  disposeAdministrativePki,
  administrativeConfiguration,
  administrativePreparationProgram,
  closeAdministrativeVolume,
  closeAdministrativeNetwork,
  createAdministrativeDockerClient,
  administrativeHolderProcessProgram,
} from "../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs";

test("native preflight profiles are a closed immutable finite matrix", () => {
  assert.equal(administrativePreflightProfiles.length, 12);
  assert.equal(new Set(administrativePreflightProfiles.map((value) => value.name)).size, 12);
  for (const profile of administrativePreflightProfiles) {
    assert.ok(Object.isFrozen(profile));
    assert.equal(parseAdministrativePreflightProfile(profile.name), profile);
    assert.equal(
      profile.operation,
      ["seed", "provision"].includes(profile.name) ? profile.name : "migrate",
    );
    assert.equal(profile.databaseHost, "postgres.us-demo.internal");
    assert.equal(profile.databaseName, "markiro_us_synthetic");
    assert.equal(profile.databaseUser, "markiro_us");
  }
  assert.ok(Object.isFrozen(administrativePreflightProfiles));
  assert.equal(administrativePreflightProfiles.filter((value) => value.server).length, 8);
});

test("profile parsing refuses caller-selected endpoints, extra text and structural inputs", () => {
  for (const value of [
    undefined,
    null,
    {},
    "",
    "migrate\n",
    "wrongCA extra",
    "../migrate",
    "other",
    "toString",
  ])
    assert.throws(
      () => parseAdministrativePreflightProfile(value),
      /us_hosted_admin_fixture_invalid/,
    );
});

test("cleanup requires exact invocation owner and a valid full container identity", () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const record = { containerId: "a".repeat(64), owner };
  assert.doesNotThrow(() => assertAdministrativeFixtureOwner(record, owner));
  for (const value of [{ ...record, containerId: "abc" }, { ...record, owner: "other" }, {}, null])
    assert.throws(
      () => assertAdministrativeFixtureOwner(value, owner),
      /us_hosted_admin_fixture_invalid/,
    );
  assert.throws(
    () => assertAdministrativeFixtureOwner(record, "other"),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("holder cleanup requires actual PID1-only settlement and never accepts orphan children", () => {
  assert.doesNotThrow(() => assertAdministrativeHolderSettled("PID COMMAND\n1 MainThread\n"));

  for (const value of [
    "",
    "PID COMMAND\n2 node\n",
    "PID COMMAND\n1 node\n12 node\n",
    "PID COMMAND\n1 node\n22 ps\n",
    "PID COMMAND\n1 node\n22 ps\n23 ps\n",
    "PID COMMAND\n1 sh\n",
  ])
    assert.throws(
      () => assertAdministrativeHolderSettled(value),
      /us_hosted_admin_actual_child_settlement_pending/,
    );
});

test("package locator is bounded unverified metadata under this worktree only", () => {
  const root = "/synthetic/unit/worktree";
  const value = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    baseSha: "a".repeat(40),
    patchSha256: "b".repeat(64),
    fixtureSha: "c".repeat(40),
    source: root + "/.superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/unit/source",
    manifestSha256: "d".repeat(64),
    adminManifestSha256: "e".repeat(64),
  };
  const result = parseAdministrativePackageLocator(JSON.stringify(value), root);
  assert.deepEqual(result, value);
  assert.ok(Object.isFrozen(result));
  for (const other of [
    null,
    [],
    { ...value, extra: true },
    { ...value, purpose: "production" },
    { ...value, fixtureSha: "C".repeat(40) },
    { ...value, source: "/other/source" },
    { ...value, source: value.source + "/../source" },
    { ...value, manifestSha256: "d".repeat(64) + "\n" },
  ])
    assert.throws(
      () => parseAdministrativePackageLocator(JSON.stringify(other), root),
      /us_hosted_admin_fixture_invalid/,
    );
  for (const document of ["{", "", JSON.stringify(value).padStart(16385, " ")])
    assert.throws(
      () => parseAdministrativePackageLocator(document, root),
      /us_hosted_admin_fixture_invalid/,
    );
});

test("every fixed native exercise program parses before owned resources are started", async () => {
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { compileFunction, Script } = await import("node:vm");
  const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url));
  const ts = require("typescript");
  const text = readFileSync(
    new URL(
      "../../../apps/api/test/us-hosted-admin-preflight-installed.e2e.test.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const source = ts.createSourceFile("native.test.ts", text, ts.ScriptTarget.Latest, true);
  let checked = 0;
  let processPrograms = 0;
  const receipt = {
    fixtureSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    adminManifestSha256: "c".repeat(64),
  };
  const visit = (node) => {
    if (ts.isTemplateExpression(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const expression = node.getText(source);
      if (expression.includes("fs.readdirSync('/proc')")) {
        assert.equal(compileFunction("return " + expression)(), administrativeHolderProcessProgram);
        processPrograms++;
      }
      if (
        expression.includes("process.stdout.write(JSON.stringify({pid") ||
        expression.includes("const r=await") ||
        expression.includes("const tls=require") ||
        expression.includes("const {createRequire}") ||
        expression.includes("const fs=require")
      ) {
        const render = compileFunction("return " + expression, [
          "receipt",
          "caMutant",
          "nameMutant",
          "phase",
          "path",
          "body",
          "operation",
          "name",
        ]);
        const program = render(
          receipt,
          false,
          false,
          "connect",
          "/run/secrets/us-demo",
          "",
          "migrate",
          "PGOPTIONS",
        );
        new Script(
          program.includes("process.stdout.write(JSON.stringify({pid")
            ? program
            : "(async()=>{" + program + "})()",
        );
        checked++;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(checked, 7);
  assert.equal(processPrograms, 1);
});

test("actual holder removal refuses foreign ownership and live children before mutation", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const record = { containerId: "a".repeat(64), owner };
  for (const variant of ["foreign", "live"]) {
    const mutations = [];
    const command = async (args) => {
      if (args[0] === "inspect") return variant === "foreign" ? "another-invocation" : owner;
      if (args[0] === "exec") return "PID COMMAND\n1 MainThread\n12 node\n";
      mutations.push(args);
      return "";
    };
    await assert.rejects(
      closeAdministrativeHolder(record, command),
      /us_hosted_admin_(fixture_invalid|actual_child_settlement_pending)/,
    );
    assert.equal(mutations.length, 0);
  }
});

test("normal holder removal verifies exit zero and absence without force flags", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const record = { containerId: "a".repeat(64), owner };
  const mutations = [];
  const command = async (args) => {
    if (args[0] === "inspect") return args.includes("{{.State.ExitCode}}") ? "0" : owner;
    if (args[0] === "exec") return "PID COMMAND\n1 MainThread\n";
    if (args[0] === "container") return "";
    mutations.push(args);
    return "";
  };
  const proof = await closeAdministrativeHolder(record, command);
  assert.deepEqual(mutations, [
    ["stop", "--time", "2", record.containerId],
    ["rm", record.containerId],
  ]);
  assert.equal(proof.absent, true);
});

test("holder cleanup pins identity before awaiting the ownership observation", async () => {
  const initial = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const replacement = "us-admin-preflight-22222222-2222-4222-8222-222222222222";
  const record = { containerId: "a".repeat(64), owner: initial };
  const mutations = [];
  const command = async (args) => {
    if (args[0] === "inspect") {
      record.owner = replacement;
      return replacement;
    }
    if (args[0] === "exec") return "PID COMMAND\n1 MainThread\n";
    mutations.push(args);
    return "";
  };
  await assert.rejects(
    closeAdministrativeHolder(record, command),
    /us_hosted_admin_fixture_invalid/,
  );
  assert.equal(mutations.length, 0);
});

test("holder inspection reports namespace peers and excludes only its own process", async () => {
  const { runInNewContext } = await import("node:vm");
  let output = "";
  runInNewContext(administrativeHolderProcessProgram, {
    require: (name) => {
      assert.equal(name, "node:fs");
      return {
        readdirSync: () => ["1", "42", "80", "self"],
        readFileSync: (path) => (path === "/proc/1/comm" ? "MainThread\n" : "node\n"),
      };
    },
    process: {
      pid: 80,
      stdout: {
        write: (value) => {
          output += value;
        },
      },
    },
  });
  assert.equal(output, "PID COMMAND\n1 MainThread\n42 node\n");
  assert.throws(() => assertAdministrativeHolderSettled(output), /settlement_pending/);
});

test("holder close refuses abnormal exit and never removes a failed holder", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const record = { containerId: "a".repeat(64), owner };
  const mutations = [];
  await assert.rejects(
    closeAdministrativeHolder(record, async (args) => {
      if (args[0] === "inspect") return args.includes("{{.State.ExitCode}}") ? "137" : owner;
      if (args[0] === "exec") return "PID COMMAND\n1 MainThread\n";
      mutations.push(args);
      return "";
    }),
    /us_hosted_admin_fixture_invalid/,
  );
  assert.deepEqual(mutations, [["stop", "--time", "2", record.containerId]]);
});

test("holder close requires observed absence and propagates client failures", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const record = { containerId: "a".repeat(64), owner };
  const command = async (args) => {
    if (args[0] === "inspect") return args.includes("{{.State.ExitCode}}") ? "0" : owner;
    if (args[0] === "exec") return "PID COMMAND\n1 MainThread\n";
    if (args[0] === "container") return record.containerId;
    return "";
  };
  await assert.rejects(
    closeAdministrativeHolder(record, command),
    /us_hosted_admin_fixture_invalid/,
  );
  const failure = new Error("bounded_client_failure");
  await assert.rejects(
    closeAdministrativeHolder(record, async () => {
      throw failure;
    }),
    (error) => error === failure,
  );
});

test("Docker adapter bounds operations and protected stdin without capturing failure output", async () => {
  const calls = [];
  const execute = (file, args, options, done) => {
    const call = { file, args, options, input: null };
    calls.push(call);
    queueMicrotask(() => done(null, "[1]\n", "private-stderr"));
    return {
      stdin: {
        on: () => {},
        end: (input) => {
          call.input = input === undefined ? undefined : Buffer.from(input);
        },
      },
    };
  };
  const client = createAdministrativeDockerClient(execute);
  const secret = Buffer.from("synthetic-only-value");
  assert.equal(await client.run(["exec", "-i", "fixture", "node"], secret), "[1]\n");
  await client.run(["cp", "source", "fixture:/app"]);
  assert.equal(calls[0].file, "docker");
  assert.equal(calls[0].options.timeout, 30000);
  assert.equal(calls[1].options.timeout, 90000);
  assert.equal(calls[0].options.maxBuffer, 1048576);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].input, secret);
  assert.ok(!calls[0].args.join(" ").includes(secret.toString()));
  await client.settle();
});

test("Docker adapter tracks settlement and redacts arbitrary subprocess errors", async () => {
  let done;
  const client = createAdministrativeDockerClient((_file, _args, _options, callback) => {
    done = callback;
    return { stdin: { on: () => {}, end: () => {} } };
  });
  const operation = client.run(["inspect", "fixture"]);
  let settled = false;
  const pending = client.settle().then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  const privateError = new Error("private-subprocess-output");
  privateError.killed = true;
  done(privateError, "private-stdout", "private-stderr");
  await assert.rejects(operation, (error) => {
    assert.equal(error.message, "us_hosted_admin_docker_failed");
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes("private"));
    return true;
  });
  await pending;
  assert.equal(settled, true);
});

test("volume and network closure refuse foreign labels and attached resources", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  for (const kind of ["volume", "network"]) {
    const close = kind === "volume" ? closeAdministrativeVolume : closeAdministrativeNetwork;
    const record = { owner, name: owner + (kind === "volume" ? "-app" : "-network") };
    for (const variant of ["foreign", "attached"]) {
      const mutations = [];
      const command = async (args) => {
        if (args.includes('{{index .Labels "us-fixture-owner"}}'))
          return variant === "foreign" ? "other" : owner;
        if (args[0] === "container") return "a".repeat(64);
        if (args.includes("{{json .Containers}}")) return JSON.stringify({ foreignMember: {} });
        mutations.push(args);
        return "";
      };
      await assert.rejects(close(record, command), /us_hosted_admin_fixture_invalid/);
      assert.deepEqual(mutations, []);
    }
  }
});

test("owned unattached volumes and internal networks require normal removal and absence", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  for (const kind of ["volume", "network"]) {
    const close = kind === "volume" ? closeAdministrativeVolume : closeAdministrativeNetwork;
    const record = { owner, name: owner + (kind === "volume" ? "-secrets" : "-network") };
    const mutations = [];
    const command = async (args) => {
      if (args.includes('{{index .Labels "us-fixture-owner"}}')) return owner;
      if (args.includes("{{json .Containers}}")) return "{}";
      if (args.includes("{{.Internal}}")) return "true";
      if (args.includes("rm")) mutations.push(args);
      return "";
    };
    assert.equal((await close(record, command)).absent, true);
    assert.deepEqual(mutations, [[kind, "rm", record.name]]);
  }
});

test("resource acquisition persists each intent before mutation and pins private topology", async () => {
  const events = [];
  let snapshot;
  const command = async (args) => {
    events.push(args);
    if (args[1] === "create") {
      assert.equal(snapshot.phase, args[0] + "_create_intent");
      assert.equal(snapshot.profile, "migrate");
      assert.ok(args.includes("us-fixture-owner=" + snapshot.owner));
      if (args[0] === "network") {
        assert.ok(args.includes("--internal"));
        return "a".repeat(64);
      }
      return args.at(-1);
    }
    if (args.includes('{{index .Labels "us-fixture-owner"}}')) return snapshot.owner;
    if (args.includes("{{.Internal}}")) return "true";
    if (args.includes("{{.Id}}")) return "a".repeat(64);
    return "";
  };
  const result = await acquireAdministrativeFixtureResources("migrate", command, async (value) => {
    snapshot = value;
  });
  assert.equal(result.volumes.length, 3);
  assert.equal(result.network.name, result.owner + "-network");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.volumes));
  assert.equal(events.filter((args) => args[1] === "create").length, 4);
});

test("material-only fixture acquires no network and failed intent persistence mutates nothing", async () => {
  let current;
  const events = [];
  const command = async (args) => {
    events.push(args);
    if (args[1] === "create") return args.at(-1);
    if (args.includes('{{index .Labels "us-fixture-owner"}}')) return current.owner;
    return "";
  };
  const result = await acquireAdministrativeFixtureResources("badMode", command, async (value) => {
    current = value;
  });
  assert.equal(result.volumes.length, 2);
  assert.equal(result.network, null);
  assert.equal(events.filter((args) => args[0] === "network").length, 0);
  const failure = new Error("private_ledger_write_failed");
  let mutations = 0;
  await assert.rejects(
    acquireAdministrativeFixtureResources(
      "migrate",
      async (args) => {
        if (args[1] === "create") mutations++;
        return "";
      },
      async () => {
        throw failure;
      },
    ),
    (error) => error === failure,
  );
  assert.equal(mutations, 0);
});

test("stdin failure cannot declare a still-running Docker client settled", async () => {
  let done;
  const client = createAdministrativeDockerClient((_file, _args, _options, callback) => {
    done = callback;
    return {
      stdin: {
        on: () => {},
        end: () => {
          throw new Error("private_stdin_failure");
        },
      },
    };
  });
  let finished = false;
  const operation = client.run(["exec", "-i", "fixture", "node"], Buffer.from("synthetic"));
  void operation.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  await new Promise(setImmediate);
  assert.equal(finished, false);
  done(null, "success-is-not-input-delivery-proof", "");
  await assert.rejects(operation, /us_hosted_admin_docker_failed/);
  await client.settle();
});

test("holder acquisition uses only cached fixed images, readonly mounts and closed identities", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const volumes = ["app", "secrets", "server"].map((suffix) => ({
    name: owner + "-" + suffix,
    owner,
    created: true,
  }));
  const resources = {
    phase: "resources_created",
    profile: "migrate",
    owner,
    volumes,
    network: { name: owner + "-network", owner, created: true, id: "b".repeat(64) },
  };
  for (const phase of ["prepare", "holder"]) {
    let intent;
    let created;
    const command = async (args) => {
      if (args[0] === "create") {
        assert.equal(intent.phase, "holder_create_intent");
        created = args;
        return "a".repeat(64);
      }
      if (args.includes('{{index .Labels "us-fixture-owner"}}')) return owner;
      if (args.includes("{{.Internal}}")) return "true";
      if (args.includes("{{.Id}}")) return "b".repeat(64);
      if (args.includes("{{json .Mounts}}"))
        return JSON.stringify(
          volumes
            .filter((_v, index) => phase === "prepare" || index !== 2)
            .map((v, index) => ({
              Type: "volume",
              Name: v.name,
              Destination:
                index === 0 ? "/app" : index === 1 ? "/run/secrets/us-demo" : "/fixture-server",
              RW: phase === "prepare",
            })),
        );
      if (args.includes('{{index .Config.Labels "us-fixture-owner"}}')) return owner;
      if (args.includes("{{.State.Running}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}"))
        return phase === "prepare" ? "true 0:0 true" : "true 10001:10001 true";
      return "";
    };
    const holder = await createAdministrativeHolder(resources, phase, command, async (value) => {
      intent = value;
    });
    assert.equal(holder.containerId, "a".repeat(64));
    assert.equal(holder.owner, owner);
    assert.ok(created.includes("--pull=never"));
    assert.ok(created.includes("--read-only"));
    assert.ok(
      created.includes("sha256:9be410e06dadc1794f44aa4c0fd107a7ecb2edb5cb6bcc6a71c7888caf3cfa12"),
    );
    const app = created.find((value) => value.startsWith("type=volume,src=" + owner + "-app,"));
    assert.equal(app.endsWith(",readonly"), phase === "holder");
    assert.equal(created.includes("--network=none"), phase === "prepare");
    assert.equal(
      created.some((value) => value.includes("dst=/fixture-server")),
      phase === "prepare",
    );
    if (phase === "holder") assert.ok(created.includes("--cap-drop=ALL"));
  }
});

test("holder acquisition refuses resource substitutions before creating anything", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const resources = {
    phase: "resources_created",
    profile: "badMode",
    owner,
    volumes: ["app", "secrets"].map((suffix) => ({
      name: owner + "-" + suffix,
      owner,
      created: true,
    })),
    network: null,
  };
  for (const variant of [
    { ...resources, owner: "other" },
    { ...resources, volumes: [...resources.volumes, resources.volumes[0]] },
    { ...resources, volumes: resources.volumes.map((value) => ({ ...value, created: false })) },
    { ...resources, network: { name: "foreign" } },
  ]) {
    let mutations = 0;
    await assert.rejects(
      createAdministrativeHolder(
        variant,
        "holder",
        async (args) => {
          if (["create", "start"].includes(args[0])) mutations++;
          return owner;
        },
        async () => {},
      ),
      /us_hosted_admin_fixture_invalid/,
    );
    assert.equal(mutations, 0);
  }
});

test("holder creation refuses changed network identity and unexpected mount tables", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const resources = {
    phase: "resources_created",
    profile: "migrate",
    owner,
    volumes: ["app", "secrets", "server"].map((suffix) => ({
      name: owner + "-" + suffix,
      owner,
      created: true,
    })),
    network: { name: owner + "-network", owner, created: true, id: "b".repeat(64) },
  };
  for (const variant of ["network", "mount"]) {
    let creates = 0;
    const command = async (args) => {
      if (args[0] === "create") {
        creates++;
        return "a".repeat(64);
      }
      if (
        args.includes('{{index .Labels "us-fixture-owner"}}') ||
        args.includes('{{index .Config.Labels "us-fixture-owner"}}')
      )
        return owner;
      if (args.includes("{{.Internal}}")) return "true";
      if (args.includes("{{.Id}}")) return (variant === "network" ? "c" : "b").repeat(64);
      if (args.includes("{{.State.Running}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}}"))
        return "true 10001:10001 true";
      if (args.includes("{{json .Mounts}}"))
        return JSON.stringify([
          { Type: "bind", Source: "/foreign", Destination: "/app", RW: true },
        ]);
      return "";
    };
    await assert.rejects(
      createAdministrativeHolder(resources, "holder", command, async () => {}),
      /us_hosted_admin_fixture_invalid/,
    );
    assert.equal(creates, variant === "network" ? 0 : 1);
  }
});

test("operation configuration pins only the expected administrative material paths", () => {
  const locator = {
    fixtureSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    adminManifestSha256: "c".repeat(64),
  };
  for (const profile of administrativePreflightProfiles) {
    const config = administrativeConfiguration(locator, profile.name);
    assert.equal(config.operation, profile.operation);
    assert.equal(config.service, "admin");
    assert.equal(
      config.database.passwordFile,
      "/run/secrets/us-demo/admin-" + profile.operation + "-db-password",
    );
    assert.equal(config.database.host, "postgres.us-demo.internal");
    assert.equal(config.database.name, "markiro_us_synthetic");
    assert.equal(config.database.user, "markiro_us");
    assert.equal(Object.hasOwn(config, "storage"), profile.operation === "seed");
    assert.ok(Object.isFrozen(config.release));
  }
  assert.throws(
    () => administrativeConfiguration({ ...locator, fixtureSha: "other" }, "migrate"),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("preparation program has fixed protected destinations and independent negative variants", async () => {
  const { runInNewContext } = await import("node:vm");
  const locator = {
    fixtureSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    adminManifestSha256: "c".repeat(64),
  };
  for (const name of ["migrate", "seed", "badMode", "badCA", "oversizedSecret", "symlinkSecret"]) {
    const files = new Map();
    const modes = new Map();
    const owners = new Map();
    const links = new Map();
    let output = "";
    const payload = JSON.stringify({
      profile: name,
      config: administrativeConfiguration(locator, name),
      dbPassword: "synthetic-password",
      dbCA: "PUBLIC-CA",
      storageAccess: "synthetic-access",
      storageSecret: "synthetic-secret",
      storageCA: "PUBLIC-STORAGE-CA",
      serverCertificate: "PUBLIC-CERT",
      serverKey: "SYNTHETIC-KEY",
    });
    const fs = {
      readFileSync: (value) => {
        assert.equal(value, 0);
        return payload;
      },
      mkdirSync: () => {},
      chownSync: (path, uid, gid) => owners.set(path, [uid, gid]),
      chmodSync: (path, mode) => modes.set(path, mode),
      writeFileSync: (path, bytes, options) => {
        assert.equal(options.flag, "wx");
        files.set(path, bytes);
        modes.set(path, options.mode);
      },
      symlinkSync: (target, path) => links.set(path, target),
      lchownSync: (path, uid, gid) => owners.set(path, [uid, gid]),
      readdirSync: () => [],
      lstatSync: () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
      }),
    };
    runInNewContext(administrativePreparationProgram, {
      require: (mod) => {
        assert.equal(mod, "node:fs");
        return fs;
      },
      Buffer,
      process: {
        getuid: () => 0,
        stdout: {
          write: (value) => {
            output += value;
          },
        },
      },
    });
    assert.equal(output, "[1]\n");
    const operation = name === "seed" ? "seed" : "migrate";
    const passwordPath = "/run/secrets/us-demo/admin-" + operation + "-db-password";
    assert.equal(
      modes.get(passwordPath),
      name === "badMode" ? 0o444 : name === "symlinkSecret" ? undefined : 0o440,
    );
    if (name === "symlinkSecret")
      assert.equal(links.get(passwordPath), "/run/secrets/us-demo/synthetic-target");
    else
      assert.equal(
        files.get(passwordPath).length,
        name === "oversizedSecret" ? 4097 : "synthetic-password".length,
      );
    assert.equal(
      files.get("/run/secrets/us-demo/db-ca.pem"),
      name === "badCA" ? "invalid-ca" : "PUBLIC-CA",
    );
    assert.equal(files.has("/run/secrets/us-demo/admin-seed-storage-access-key"), name === "seed");
    if (name === "migrate" || name === "seed") {
      assert.deepEqual(owners.get("/fixture-server/server.key"), [70, 70]);
      assert.equal(modes.get("/fixture-server/server.key"), 0o600);
      assert.equal(files.has("/run/secrets/us-demo/server.key"), false);
    }
  }
});

test("Postgres acquisition has a private fixed DNS target, protected password file and tmpfs data", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  for (const profile of ["migrate", "plaintext", "wrongDatabase", "wrongUser"]) {
    const resources = {
      phase: "resources_created",
      profile,
      owner,
      volumes: ["app", "secrets", "server"].map((suffix) => ({
        name: owner + "-" + suffix,
        owner,
        created: true,
      })),
      network: { name: owner + "-network", owner, created: true, id: "b".repeat(64) },
    };
    let created;
    let snapshot;
    const command = async (args) => {
      if (args[0] === "create") {
        assert.equal(snapshot.phase, "postgres_create_intent");
        created = args;
        return "c".repeat(64);
      }
      if (
        args.includes('{{index .Labels "us-fixture-owner"}}') ||
        args.includes('{{index .Config.Labels "us-fixture-owner"}}')
      )
        return owner;
      if (args.includes("{{.Internal}}")) return "true";
      if (args.includes("{{.Id}}")) return "b".repeat(64);
      if (args.includes("{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}")) return "0:0 true";
      if (args.includes("{{json .Mounts}}"))
        return JSON.stringify([
          {
            Type: "volume",
            Name: owner + "-server",
            Destination: "/run/us-demo-server",
            RW: false,
          },
        ]);
      if (args.includes("{{.HostConfig.NetworkMode}}")) return "bridge";
      if (args.includes("{{json .HostConfig.PortBindings}}")) return "{}";
      if (args.includes("{{json .NetworkSettings.Networks}}"))
        return JSON.stringify({
          [owner + "-network"]: {
            NetworkID: "b".repeat(64),
            Aliases: ["postgres.us-demo.internal"],
          },
        });
      return "";
    };
    const server = await createAdministrativePostgres(resources, command, async (value) => {
      snapshot = value;
    });
    assert.equal(server.owner, owner);
    assert.equal(server.containerId, "c".repeat(64));
    assert.ok(created.includes("--pull=never"));
    assert.ok(created.includes("--read-only"));
    assert.ok(created.includes("postgres.us-demo.internal"));
    assert.ok(created.includes("POSTGRES_PASSWORD_FILE=/run/us-demo-server/db-password"));
    assert.ok(
      created.includes(
        "POSTGRES_USER=" + (profile === "wrongUser" ? "markiro_other" : "markiro_us"),
      ),
    );
    assert.ok(
      created.includes(
        "POSTGRES_DB=" + (profile === "wrongDatabase" ? "markiro_other" : "markiro_us_synthetic"),
      ),
    );
    assert.ok(created.includes("ssl=" + (profile === "plaintext" ? "off" : "on")));
    assert.equal(
      created.some((arg) => arg.startsWith("POSTGRES_PASSWORD=")),
      false,
    );
    assert.equal(created.includes("-p"), false);
    assert.ok(
      created.some(
        (arg) =>
          arg.includes("/var/lib/postgresql/data:") &&
          !arg.includes("uid=") &&
          !arg.includes("gid=") &&
          arg.includes("mode=0700"),
      ),
    );
  }
});

test("Postgres creation refuses unexpected mounts before starting the owned server", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const resources = {
    phase: "resources_created",
    profile: "migrate",
    owner,
    volumes: ["app", "secrets", "server"].map((suffix) => ({
      name: owner + "-" + suffix,
      owner,
      created: true,
    })),
    network: { name: owner + "-network", owner, created: true, id: "b".repeat(64) },
  };
  let starts = 0;
  const command = async (args) => {
    if (args[0] === "create") return "c".repeat(64);
    if (args[0] === "start") starts++;
    if (
      args.includes('{{index .Labels "us-fixture-owner"}}') ||
      args.includes('{{index .Config.Labels "us-fixture-owner"}}')
    )
      return owner;
    if (args.includes("{{.Internal}}")) return "true";
    if (args.includes("{{.Id}}")) return "b".repeat(64);
    if (args.includes("{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}")) return "0:0 true";
    if (args.includes("{{json .Mounts}}"))
      return JSON.stringify([
        { Type: "bind", Source: "/foreign", Destination: "/run/us-demo-server", RW: false },
      ]);
    return "";
  };
  await assert.rejects(
    createAdministrativePostgres(resources, command, async () => {}),
    /us_hosted_admin_fixture_invalid/,
  );
  assert.equal(starts, 0);
});

test("Postgres readiness waits only for known initialization states within the fixed setup deadline", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const holder = { owner, containerId: "a".repeat(64) };
  let now = 0;
  let probes = 0;
  const command = async (args, _input, timeout) => {
    assert.ok(timeout > 0 && timeout <= 30000);
    if (args[0] === "inspect") return owner;
    probes++;
    assert.ok(args.some((value) => value.includes("pg_isready")));
    return probes === 1 ? "[0]\n" : "[1]\n";
  };
  const result = await waitForAdministrativePostgres(holder, "migrate", command, 120000, {
    now: () => now,
    delay: async (ms) => {
      now += ms;
    },
  });
  assert.equal(result.ready, true);
  assert.equal(probes, 2);
  assert.equal(now, 250);
  let calls = 0;
  await assert.rejects(
    waitForAdministrativePostgres(
      holder,
      "migrate",
      async () => {
        calls++;
        return "[1]";
      },
      250,
      { now: () => 250, delay: async () => {} },
    ),
    /us_hosted_admin_setup_deadline/,
  );
  assert.equal(calls, 0);
});

test("Postgres readiness never retries a foreign owner, unknown response or client error", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const holder = { owner, containerId: "a".repeat(64) };
  for (const variant of ["foreign", "unknown", "client"]) {
    let probes = 0;
    await assert.rejects(
      waitForAdministrativePostgres(
        holder,
        "migrate",
        async (args) => {
          if (args[0] === "inspect") return variant === "foreign" ? "other" : owner;
          probes++;
          if (variant === "client") throw new Error("bounded_client_failed");
          return "unrecognized";
        },
        120000,
        {
          now: () => 0,
          delay: async () => {
            throw new Error("must_not_retry");
          },
        },
      ),
      /us_hosted_admin_fixture_invalid|bounded_client_failed/,
    );
    assert.equal(probes, variant === "foreign" ? 0 : 1);
  }
});

test("Postgres normal closure requires zero clients, settled server processes, exit zero and absence", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const holder = { owner, containerId: "a".repeat(64) };
  for (const active of [false, true]) {
    const mutations = [];
    const command = async (args) => {
      if (args[0] === "inspect") return args.includes("{{.State.ExitCode}}") ? "0" : owner;
      if (args[0] === "exec") return args.includes("psql") ? (active ? "1\n" : "0\n") : "[1]\n";
      if (args[0] === "container") return "";
      mutations.push(args);
      return "";
    };
    if (active) {
      await assert.rejects(
        closeAdministrativePostgres(holder, "migrate", command),
        /us_hosted_admin_fixture_invalid/,
      );
      assert.deepEqual(mutations, []);
    } else {
      assert.equal((await closeAdministrativePostgres(holder, "migrate", command)).absent, true);
      assert.deepEqual(mutations, [
        ["stop", "--time", "2", holder.containerId],
        ["rm", holder.containerId],
      ]);
    }
  }
});

test("deadline limits can only shorten Docker operation and copy budgets", async () => {
  const timeouts = [];
  const client = createAdministrativeDockerClient((_file, _args, options, callback) => {
    timeouts.push(options.timeout);
    queueMicrotask(() => callback(null, "", ""));
    return { stdin: { on: () => {}, end: () => {} } };
  });
  await client.run(["inspect", "fixture"], undefined, 1200.7);
  await client.run(["cp", "source", "fixture:/app"], undefined, 80000);
  assert.deepEqual(timeouts, [1200, 80000]);
  for (const limit of [0, -1, NaN, Infinity, 30001])
    await assert.rejects(
      client.run(["inspect", "fixture"], undefined, limit),
      /us_hosted_admin_fixture_invalid/,
    );
  assert.equal(timeouts.length, 2);
});

test("fixed server readiness and settlement shell programs parse before fixture acquisition", async () => {
  const { spawnSync } = await import("node:child_process");
  for (const input of [
    administrativePostgresReadyProgram,
    administrativePostgresSettlementProgram,
  ]) {
    const result = spawnSync("sh", ["-n"], {
      input,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
    });
    assert.equal(result.status, 0);
    assert.equal(result.error, undefined);
    assert.equal(result.stderr, "");
  }
});

test("synthetic PKI has only fixed CA and two distinct server identities without ambient configuration", () => {
  const specification = administrativePkiSpecification;
  assert.ok(Object.isFrozen(specification));
  assert.equal(specification.commands.length, 6);
  assert.equal(Object.keys(specification.configurations).length, 6);
  assert.match(specification.configurations["root-ca.cnf"], /CA:TRUE/);
  assert.match(specification.configurations["server-ext.cnf"], /DNS:postgres.us-demo.internal/);
  assert.match(specification.configurations["wrong-ext.cnf"], /DNS:wrong.us-demo.internal/);
  for (const args of specification.commands) {
    assert.ok(Object.isFrozen(args));
    assert.ok(!args.includes("-text"));
    assert.ok(!args.includes("-CAcreateserial"));
    assert.ok(args.every((value) => !value.startsWith("/") || value.startsWith("/CN=")));
  }
});

test("synthetic PKI projection and deletion reject structural or foreign owners", async () => {
  for (const value of [
    null,
    {},
    { directory: "/private/tmp/foreign", purpose: "synthetic-test-only" },
  ]) {
    assert.throws(
      () => administrativePkiMaterial(value, "migrate"),
      /us_hosted_admin_fixture_invalid/,
    );
    await assert.rejects(disposeAdministrativePki(value), /us_hosted_admin_fixture_invalid/);
  }
});

test("package inventory hashes actual bytes and a complete dependency metadata set", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const base = await fs.mkdtemp(join(tmpdir(), "us-admin-byte-protocol-"));
  try {
    await fs.mkdir(join(base, "tree"));
    const metadata = Buffer.from(JSON.stringify({ name: "synthetic-public", version: "1.0.0" }));
    await fs.writeFile(join(base, "tree/package.json"), metadata);
    await fs.symlink("package.json", join(base, "tree/alias"));
    const records = [
      {
        path: "tree/package.json",
        byteSize: metadata.length,
        sha256: createHash("sha256").update(metadata).digest("hex"),
      },
      { path: "tree/alias", link: "package.json" },
    ];
    const proof = await verifyAdministrativeFileInventory(base, records, ["tree"], true);
    assert.equal(proof.entries, 2);
    assert.deepEqual(proof.sbom, [
      {
        path: "tree/package.json",
        name: "synthetic-public",
        version: "1.0.0",
        sha256: records[0].sha256,
      },
    ]);
    await fs.appendFile(join(base, "tree/package.json"), " ");
    await assert.rejects(
      verifyAdministrativeFileInventory(base, records, ["tree"], true),
      /us_hosted_admin_fixture_invalid/,
    );
  } finally {
    await fs.rm(base, { recursive: true });
  }
});

test("package inventory rejects unlisted bytes, escaping links and duplicate records", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const base = await fs.mkdtemp(join(tmpdir(), "us-admin-byte-refusal-"));
  try {
    await fs.mkdir(join(base, "tree"));
    await fs.writeFile(join(base, "outside"), "synthetic-private-test-only");
    await fs.symlink("../outside", join(base, "tree/link"));
    const record = { path: "tree/link", link: "../outside" };
    await assert.rejects(
      verifyAdministrativeFileInventory(base, [record], ["tree"], false),
      /us_hosted_admin_fixture_invalid/,
    );
    await assert.rejects(
      verifyAdministrativeFileInventory(base, [record, record], ["tree"], true),
      /us_hosted_admin_fixture_invalid/,
    );
    await fs.unlink(join(base, "tree/link"));
    await fs.symlink("../../outside", join(base, "tree/link"));
    await assert.rejects(
      verifyAdministrativeFileInventory(
        base,
        [{ ...record, link: "../../outside" }],
        ["tree"],
        true,
      ),
      /us_hosted_admin_fixture_invalid/,
    );
    await fs.unlink(join(base, "tree/link"));
    await fs.writeFile(join(base, "tree/unlisted"), "synthetic");
    await assert.rejects(
      verifyAdministrativeFileInventory(base, [], ["tree"], true),
      /us_hosted_admin_fixture_invalid/,
    );
  } finally {
    await fs.rm(base, { recursive: true });
  }
});

// Synthetic filesystem + Git protocol only; the bytes cannot issue a genuine release.
test("fixture package proof binds all bytes, current source, complete SBOM and unaccepted release flags", async () => {
  const fs = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { resolve, join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "us-admin-package-protocol-")));
  const source = resolve(
    root,
    ".superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/candidate/source",
  );
  const stage = resolve(source, ".superpowers/us-hosted-package"),
    app = resolve(stage, "app");
  const put = async (base, path, body) => {
    const absolute = resolve(base, path);
    await fs.mkdir(resolve(absolute, ".."), { recursive: true });
    await fs.writeFile(absolute, body);
    return { path, byteSize: Buffer.byteLength(body), sha256: sha(body) };
  };
  const baseSha = "a".repeat(40),
    fixtureSha = "b".repeat(40),
    patch = "synthetic-TEST-patch\n";
  let dirty = false;
  const git = async (cwd, args) => {
    if (args[0] === "status") return dirty ? " M fixture-source\n" : "";
    if (args[0] === "show") return patch;
    if (args[0] === "diff-tree")
      return [...administrativePreflightSourcePaths].sort().join("\n") + "\n";
    if (args[0] === "rev-parse")
      return (cwd === root || args[1] === "HEAD^" ? baseSha : fixtureSha) + "\n";
    throw new Error("unexpected_git_protocol");
  };
  try {
    for (const path of administrativePreflightSourcePaths) {
      await put(root, path, "synthetic-source:" + path);
      await put(source, path, "synthetic-source:" + path);
    }
    const files = [];
    for (const path of [
      "apps/api/dist/main.us-hosted-admin.js",
      "packages/db/dist/index.bin",
      "packages/domain/dist/index.bin",
      "packages/platform-contracts/dist/index.bin",
      "apps/admin/dist-us/index.bin",
      "packages/db/migrations/fixed.sql",
      "pnpm-lock.yaml",
      "apps/api/package.json",
      "packages/db/package.json",
      "packages/domain/package.json",
      "packages/platform-contracts/package.json",
    ])
      files.push(await put(app, path, "synthetic-artifact:" + path));
    const dependencies = [],
      sbom = [];
    for (const path of [
      "node_modules",
      "apps/api/node_modules",
      "packages/db/node_modules",
      "packages/domain/node_modules",
      "packages/platform-contracts/node_modules",
    ]) {
      const body = JSON.stringify({ name: "synthetic-public", version: "1.0.0" });
      const record = await put(app, path + "/sample/package.json", body);
      dependencies.push(record);
      sbom.push({
        path: record.path,
        name: "synthetic-public",
        version: "1.0.0",
        sha256: record.sha256,
      });
    }
    const deployment = [];
    for (const path of [
      "deploy/us-synthetic/package-spec.json",
      "deploy/us-synthetic/compose.synthetic.yml",
      "deploy/us-synthetic/ingress.conf",
      "deploy/us-synthetic/runtime.Dockerfile",
      "deploy/us-synthetic/README.md",
    ]) {
      const body = path.endsWith("README.md")
        ? "synthetic-source:" + path
        : "synthetic-deployment:" + path;
      await put(source, path, body);
      deployment.push(await put(stage, path, body));
    }
    const manifest = JSON.stringify({
      schemaVersion: 1,
      edition: "US",
      purpose: "synthetic-demo",
      build: { gitSha: fixtureSha },
      files,
    });
    const admin = JSON.stringify({
      schemaVersion: 1,
      edition: "US",
      purpose: "synthetic-demo",
      sourceSha: fixtureSha,
      runtimeManifestSha256: sha(manifest),
      entrypoint: files[0],
    });
    const depDocument = { schemaVersion: 1, files: dependencies, sbom };
    const depBytes = JSON.stringify(depDocument);
    const attestation = {
      schemaVersion: 1,
      sourceSha: fixtureSha,
      manifestSha256: sha(manifest),
      files: deployment,
      dependencyAttestationSha256: sha(depBytes),
      imageDigestVerified: false,
      protectedImageAttestationRequired: true,
      deploymentReady: false,
      releaseEnabled: false,
    };
    await put(app, "us-synthetic-release.json", manifest);
    await put(app, "us-synthetic-admin-release.json", admin);
    await put(stage, "dependency-attestation.json", depBytes);
    await put(stage, "deployment-attestation.json", JSON.stringify(attestation));
    const locator = {
      schemaVersion: 1,
      purpose: "synthetic-test-only",
      baseSha,
      fixtureSha,
      patchSha256: sha(patch),
      source,
      manifestSha256: sha(manifest),
      adminManifestSha256: sha(admin),
    };
    const proof = await verifyAdministrativeFixturePackage(locator, root, git);
    assert.equal(proof.artifactFiles, 11);
    assert.equal(proof.dependencyEntries, 5);
    assert.equal(proof.sbomEntries, 5);
    assert.equal(proof.deploymentFiles, 5);
    assert.equal(proof.currentSourceHashes.length, 11);
    assert.equal(proof.fixtureArtifactsPromotable, false);
    assert.equal(proof.releaseEnabled, false);
    dirty = true;
    await assert.rejects(
      verifyAdministrativeFixturePackage(locator, root, git),
      /us_hosted_admin_fixture_invalid/,
    );
    dirty = false;
    await put(app, "unlisted", "synthetic-only");
    await assert.rejects(
      verifyAdministrativeFixturePackage(locator, root, git),
      /us_hosted_admin_fixture_invalid/,
    );
    await fs.unlink(resolve(app, "unlisted"));
    await put(
      stage,
      "deployment-attestation.json",
      JSON.stringify({ ...attestation, releaseEnabled: true }),
    );
    await assert.rejects(
      verifyAdministrativeFixturePackage(locator, root, git),
      /us_hosted_admin_fixture_invalid/,
    );
    await put(stage, "deployment-attestation.json", JSON.stringify(attestation));
    const incomplete = JSON.stringify({ ...depDocument, sbom: sbom.slice(1) });
    await put(stage, "dependency-attestation.json", incomplete);
    await put(
      stage,
      "deployment-attestation.json",
      JSON.stringify({ ...attestation, dependencyAttestationSha256: sha(incomplete) }),
    );
    await assert.rejects(
      verifyAdministrativeFixturePackage(locator, root, git),
      /us_hosted_admin_fixture_invalid/,
    );
  } finally {
    await fs.rm(root, { recursive: true });
  }
});

test("large dependency binaries stream independently of the unchanged 32MiB artifact bound", async () => {
  const fs = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createHash } = await import("node:crypto");
  const base = await fs.mkdtemp(join(tmpdir(), "us-admin-large-byte-protocol-"));
  try {
    await fs.mkdir(join(base, "tree"));
    const path = join(base, "tree/native.bin"),
      bytes = 33 * 1024 * 1024;
    const file = await fs.open(path, "wx");
    try {
      await file.truncate(bytes);
    } finally {
      await file.close();
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    const records = [{ path: "tree/native.bin", byteSize: bytes, sha256: hash.digest("hex") }];
    await assert.rejects(
      verifyAdministrativeFileInventory(base, records, ["tree"], false),
      /us_hosted_admin_fixture_invalid/,
    );
    assert.equal(
      (await verifyAdministrativeFileInventory(base, records, ["tree"], true)).entries,
      1,
    );
  } finally {
    await fs.rm(base, { recursive: true });
  }
});

test("serial topology verifies before acquisition, keeps material out of its ledger and closes all owned resources", async () => {
  const root = "/synthetic";
  const locator = {
    schemaVersion: 1,
    purpose: "synthetic-test-only",
    baseSha: "a".repeat(40),
    fixtureSha: "b".repeat(40),
    patchSha256: "c".repeat(64),
    manifestSha256: "d".repeat(64),
    adminManifestSha256: "e".repeat(64),
    source:
      root + "/.superpowers/sdd/2026-10-22-us-11-demo-viewer/installed-fixtures/candidate/source",
  };
  const events = [],
    projections = new Map();
  let receipt,
    timestamp = 0;
  const owned = (profile) =>
    "us-admin-preflight-00000000-0000-4000-8000-" +
    String(administrativePreflightProfiles.findIndex((p) => p.name === profile)).padStart(12, "0");
  const id = (value) => value.toString(16).padStart(64, "0");
  const dependencies = {
    verify: async () => {
      events.push("verify");
      return {
        ...locator,
        fixtureArtifactsPromotable: false,
        imageDigestVerified: false,
        deploymentReady: false,
        releaseEnabled: false,
      };
    },
    createClient: () => ({
      run: async (args) => {
        timestamp++;
        events.push(args[0]);
        return args[0] === "cp" ? "" : "[1]\n";
      },
      settle: async () => {
        events.push("clients_settled");
      },
    }),
    preflight: async () => {
      events.push("preflight");
    },
    createPki: async () => {
      events.push("pki");
      return {};
    },
    pkiMaterial: (_owner, profile) => {
      projections.set(profile, (projections.get(profile) ?? 0) + 1);
      return { dbPassword: "DO_NOT_PERSIST", serverKey: "DO_NOT_PERSIST" };
    },
    acquireResources: async (profile) => {
      events.push("resources:" + profile);
      const owner = owned(profile),
        server = administrativePreflightProfiles.find((p) => p.name === profile).server;
      return {
        phase: "resources_created",
        profile,
        owner,
        volumes: (server ? ["app", "secrets", "server"] : ["app", "secrets"]).map((suffix) => ({
          name: owner + "-" + suffix,
          owner,
          created: true,
        })),
        network: server ? { name: owner + "-network", owner, id: id(900), created: true } : null,
      };
    },
    createHolder: async (resources, phase) => ({
      owner: resources.owner,
      containerId: id(
        administrativePreflightProfiles.findIndex((p) => p.name === resources.profile) +
          (phase === "prepare" ? 200 : 1),
      ),
    }),
    closeHolder: async (holder) => {
      events.push("close_holder");
      return { ...holder, absent: true };
    },
    createPostgres: async (resources) => ({
      owner: resources.owner,
      containerId: id(
        administrativePreflightProfiles.findIndex((p) => p.name === resources.profile) + 100,
      ),
    }),
    waitPostgres: async (_holder, _profile, _command, deadline) => {
      assert.ok(deadline <= timestamp + 120000);
      events.push("ready");
    },
    closePostgres: async (holder) => {
      events.push("close_pg");
      return { ...holder, absent: true };
    },
    closeVolume: async (resource) => {
      events.push("close_volume");
      return { ...resource, absent: true };
    },
    closeNetwork: async (resource) => {
      events.push("close_network");
      return { ...resource, absent: true };
    },
    disposePki: async () => {
      events.push("delete_pki");
      return { privatePkiDeleted: true, ownedFilesRemoved: 16 };
    },
    assertAbsent: async () => {},
    writeReceipt: async (_path, bytes) => {
      events.push("write_receipt");
      receipt = Buffer.from(bytes);
    },
    readReceipt: async () => Buffer.from(receipt),
    archiveReceipt: async () => {
      events.push("archive");
    },
    now: () => timestamp,
  };
  const persist = async (snapshot) => {
    assert.ok(!JSON.stringify(snapshot).includes("DO_NOT_PERSIST"));
  };
  const handle = await prepareAdministrativeTopology(locator, root, persist, dependencies);
  assert.deepEqual(events.slice(0, 3), ["verify", "preflight", "pki"]);
  assert.equal(projections.size, 12);
  assert.ok([...projections.values()].every((value) => value === 1));
  assert.equal(Object.keys(JSON.parse(receipt).fixtures).length, 12);
  assert.equal(inspectAdministrativeTopology(handle).protocolOnly, true);
  const proof = await closeAdministrativeTopology(handle, persist);
  await assert.rejects(
    prepareAdministrativeRegressionTopology(handle, persist),
    /us_hosted_admin_fixture_invalid/,
  );
  assert.equal(proof.removedHolders, 12);
  assert.equal(proof.removedPostgres, 8);
  assert.equal(proof.removedVolumes, 32);
  assert.equal(proof.removedNetworks, 8);
  assert.ok(events.lastIndexOf("close_network") < events.indexOf("delete_pki"));
  assert.ok(events.indexOf("delete_pki") < events.indexOf("archive"));
  await assert.rejects(
    closeAdministrativeTopology({ ...handle }, persist),
    /us_hosted_admin_fixture_invalid/,
  );
  const beforeFailure = events.length;
  let failedOwner;
  await assert.rejects(
    prepareAdministrativeTopology(locator, root, persist, {
      ...dependencies,
      createClient: () => ({
        run: async (args) => {
          if (args[0] === "cp") throw new Error("us_hosted_admin_docker_failed");
          return "[1]\n";
        },
        settle: async () => {},
      }),
    }),
    (error) => {
      failedOwner = error.topologyOwner;
      return error.message === "us_hosted_admin_topology_failed";
    },
  );
  const failed = inspectAdministrativeTopology(failedOwner);
  assert.equal(failed.failurePhase, "package_copy_intent");
  assert.equal(failed.profiles.migrate.preparerClosure, null);
  assert.ok(failed.profiles.migrate.preparer.containerId);
  assert.equal(
    events
      .slice(beforeFailure)
      .some((value) => value.startsWith("close_") || value === "delete_pki"),
    false,
  );
  await assert.rejects(
    closeAdministrativeTopology(failedOwner, persist),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("local Docker preflight refuses ambient remote channels and non-unix endpoints before acquisition", async () => {
  const names = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  const previous = names.map((name) => [name, process.env[name]]);
  try {
    for (const name of names) delete process.env[name];
    let calls = 0;
    process.env.DOCKER_HOST = "tcp://remote.invalid:2375";
    await assert.rejects(
      administrativeLocalPreflight({
        run: async () => {
          calls++;
          return "";
        },
      }),
      /us_hosted_admin_fixture_invalid/,
    );
    assert.equal(calls, 0);
    delete process.env.DOCKER_HOST;
    await assert.rejects(
      administrativeLocalPreflight({
        run: async () => {
          calls++;
          return JSON.stringify("ssh://remote.invalid");
        },
      }),
      /us_hosted_admin_fixture_invalid/,
    );
    assert.equal(calls, 1);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("local Docker preflight requires both exact cached Linux ARM image identities", async () => {
  const names = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"];
  const previous = names.map((name) => [name, process.env[name]]);
  try {
    for (const name of names) delete process.env[name];
    for (const wrong of [false, true]) {
      const calls = [];
      const invoke = administrativeLocalPreflight({
        run: async (args) => {
          calls.push(args);
          if (args[0] === "context") return JSON.stringify("unix:///synthetic/docker.sock");
          return args[2] + " linux " + (wrong ? "amd64" : "arm64");
        },
      });
      if (wrong) await assert.rejects(invoke, /us_hosted_admin_fixture_invalid/);
      else {
        await invoke;
        assert.equal(calls.length, 3);
      }
      assert.ok(calls.every((args) => args[0] === "context" || args[0] === "image"));
    }
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("original runtime regression PKI is a separate fixed API identity with only three OpenSSL steps", async () => {
  const specification = administrativeRegressionPkiSpecification;
  assert.equal(specification.commands.length, 3);
  assert.equal(Object.keys(specification.configurations).length, 3);
  assert.match(specification.configurations["api-ext.cnf"], /DNS:api.us-demo.internal/);
  assert.ok(!JSON.stringify(specification).includes("postgres.us-demo.internal"));
  assert.ok(!JSON.stringify(specification).includes("wrong.us-demo.internal"));
  assert.throws(
    () => administrativeRegressionPkiMaterial({ purpose: "synthetic-test-only" }),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("original runtime configuration preserves separate API/worker identities and fixed private paths", () => {
  const locator = {
    fixtureSha: "a".repeat(40),
    manifestSha256: "b".repeat(64),
    adminManifestSha256: "c".repeat(64),
  };
  const api = administrativeRegressionRuntimeConfiguration(locator, "api");
  const worker = administrativeRegressionRuntimeConfiguration(locator, "worker");
  assert.equal(api.database.user, "markiro_us_api");
  assert.equal(worker.database.user, "markiro_us_worker");
  assert.equal(api.auth.secretFile, "/run/secrets/us-demo/api-auth-secret");
  assert.equal(Object.hasOwn(worker, "auth"), false);
  assert.equal(Object.hasOwn(worker, "tls"), false);
  assert.notEqual(api.database.passwordFile, worker.database.passwordFile);
  assert.notEqual(api.storage.secretKeyFile, worker.storage.secretKeyFile);
  assert.throws(
    () => administrativeRegressionRuntimeConfiguration(locator, "admin"),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("original regression package preparation changes only the intended negative bytes before sealing", async () => {
  const { runInNewContext } = await import("node:vm");
  const { createHash } = await import("node:crypto");
  for (const kind of ["runtime", "migrate", "wrongSupplementEntry", "wrongDescriptor"]) {
    const writes = new Map(),
      appended = [];
    let output = "";
    const supplement = JSON.stringify({ entrypoint: { byteSize: 10 } });
    const payload = JSON.stringify({
      kind,
      configurations: { api: {}, worker: {} },
      config: { operation: "migrate", release: {} },
    });
    const fs = {
      readFileSync: (path) => (path === 0 ? payload : supplement),
      writeFileSync: (path, bytes) => writes.set(path, bytes),
      appendFileSync: (path, bytes) => appended.push([path, bytes]),
      lstatSync: () => ({
        isSymbolicLink: () => false,
        isDirectory: () => true,
        isFile: () => false,
      }),
      readdirSync: () => [],
      chownSync: () => {},
      chmodSync: () => {},
      lchownSync: () => {},
    };
    runInNewContext(administrativeRegressionPackageProgram, {
      require: (name) => (name === "node:fs" ? fs : { createHash }),
      process: {
        getuid: () => 0,
        stdout: {
          write: (value) => {
            output += value;
          },
        },
      },
    });
    assert.equal(output, "[1]\n");
    assert.equal(writes.has("/app/us-synthetic-api.json"), kind === "runtime");
    assert.equal(writes.has("/app/us-synthetic-worker.json"), kind === "runtime");
    assert.equal(
      writes.has("/app/us-synthetic-admin-release.json"),
      kind === "wrongSupplementEntry",
    );
    assert.equal(appended.length, kind === "wrongDescriptor" ? 1 : 0);
    if (kind === "wrongSupplementEntry")
      assert.equal(
        JSON.parse(writes.get("/app/us-synthetic-admin-release.json")).entrypoint.byteSize,
        11,
      );
  }
});

test("runtime regression material remains root-owned and separate in each service holder", async () => {
  const { runInNewContext } = await import("node:vm");
  for (const service of ["api", "worker"]) {
    const files = new Map(),
      owners = new Map();
    let output = "";
    const payload = JSON.stringify({
      service,
      ca: "PUBLIC-CA",
      certificate: "PUBLIC-API-CERT",
      key: "SYNTHETIC-KEY",
    });
    const fs = {
      readFileSync: () => payload,
      mkdirSync: () => {},
      chmodSync: () => {},
      chownSync: (path, uid, gid) => owners.set(path, [uid, gid]),
      writeFileSync: (path, bytes, options) => {
        assert.equal(options.flag, "wx");
        assert.equal(options.mode, 0o440);
        files.set(path, bytes);
      },
    };
    runInNewContext(administrativeRegressionMaterialProgram, {
      require: (name) =>
        name === "node:fs" ? fs : { randomBytes: (length) => Buffer.alloc(length, 1) },
      process: {
        getuid: () => 0,
        stdout: {
          write: (value) => {
            output += value;
          },
        },
      },
    });
    assert.equal(output, "[1]\n");
    assert.equal(files.size, service === "api" ? 8 : 5);
    assert.equal(files.has("/run/secrets/us-demo/api-key.pem"), service === "api");
    assert.ok(
      [...files.keys()].every(
        (path) => owners.get(path)?.[0] === 0 && owners.get(path)?.[1] === 10001,
      ),
    );
  }
});

test("native regression resources require a genuine normally closed native topology owner", async () => {
  await assert.rejects(
    prepareAdministrativeRegressionTopology({ purpose: "synthetic-test-only" }, async () => {}),
    /us_hosted_admin_fixture_invalid/,
  );
});

test("native reports require exact full green counts and intended numeric TLS assertion failures", () => {
  const report = (mode) => {
    const red = mode === "ca-red" || mode === "name-red",
      count = mode === "regression-green" ? 33 : 19;
    const title =
      "refuses the actual " + (mode === "ca-red" ? "wrongCA" : "wrongName") + " database peer";
    return {
      numTotalTests: count,
      numPassedTests: red ? 0 : count,
      numFailedTests: red ? 1 : 0,
      numPendingTests: red ? 18 : 0,
      numTodoTests: 0,
      success: !red,
      testResults: [
        {
          name:
            "/synthetic/apps/api/test/" +
            (mode === "regression-green"
              ? "us-hosted-installed-entry.e2e.test.ts"
              : "us-hosted-admin-preflight-installed.e2e.test.ts"),
          message: "",
          status: red ? "failed" : "passed",
          assertionResults: Array.from({ length: count }, (_v, index) => ({
            title: red && index === 0 ? title : "synthetic test " + index,
            status: red ? (index === 0 ? "failed" : "skipped") : "passed",
            failureMessages:
              red && index === 0
                ? ["AssertionError: expected [ 0, 0, 1 ] to deeply equal [ 1, 1, 1 ]"]
                : [],
          })),
        },
      ],
    };
  };
  for (const mode of [
    "native-green",
    "native-green-restored",
    "ca-red",
    "name-red",
    "regression-green",
  ]) {
    const value = report(mode),
      exit = mode === "ca-red" || mode === "name-red" ? 1 : 0;
    assert.doesNotThrow(() => assertAdministrativeNativeReport(value, mode, exit));
    assert.throws(
      () => assertAdministrativeNativeReport({ ...value, numPendingTests: 1 }, mode, exit),
      /us_hosted_admin_native_report_invalid/,
    );
    if (exit === 1) {
      for (const actual of ["1, 1, 0", "0, 0, 0", "1, 0, 1", "7, 8, 9"]) {
        const unrelated = structuredClone(value);
        unrelated.testResults[0].assertionResults[0].failureMessages = [
          "AssertionError: expected [ " + actual + " ] to deeply equal [ 1, 1, 1 ]",
        ];
        assert.throws(
          () => assertAdministrativeNativeReport(unrelated, mode, exit),
          /us_hosted_admin_native_report_invalid/,
        );
      }
      const broken = structuredClone(value);
      broken.testResults[0].assertionResults[0].failureMessages = ["Error: timed out after 5000ms"];
      assert.throws(
        () => assertAdministrativeNativeReport(broken, mode, exit),
        /us_hosted_admin_native_report_invalid/,
      );
    }
  }
});

test("preflight executable rejects caller-selected flags before reading a locator or creating resources", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("../verify-hosted-admin-preflight.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "us_hosted_admin_preflight_refused\n");
});

test("Postgres compatibility bootstrap does not request unsupported tmpfs uid/gid and drops to the fixed server identity", async () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const resources = {
    phase: "resources_created",
    profile: "migrate",
    owner,
    volumes: ["app", "secrets", "server"].map((suffix) => ({
      name: owner + "-" + suffix,
      owner,
      created: true,
    })),
    network: { name: owner + "-network", owner, created: true, id: "b".repeat(64) },
  };
  let created;
  const command = async (args) => {
    if (args[0] === "create") {
      created = args;
      return "c".repeat(64);
    }
    if (
      args.includes('{{index .Labels "us-fixture-owner"}}') ||
      args.includes('{{index .Config.Labels "us-fixture-owner"}}')
    )
      return owner;
    if (args.includes("{{.Internal}}")) return "true";
    if (args.includes("{{.Id}}")) return "b".repeat(64);
    if (args.includes("{{.Config.User}} {{.HostConfig.ReadonlyRootfs}}"))
      return created[created.indexOf("--user") + 1] + " true";
    if (args.includes("{{json .Mounts}}"))
      return JSON.stringify([
        { Type: "volume", Name: owner + "-server", Destination: "/run/us-demo-server", RW: false },
      ]);
    if (args.includes("{{.HostConfig.NetworkMode}}")) return "bridge";
    if (args.includes("{{json .HostConfig.PortBindings}}")) return "{}";
    if (args.includes("{{json .NetworkSettings.Networks}}"))
      return JSON.stringify({
        [owner + "-network"]: { NetworkID: "b".repeat(64), Aliases: ["postgres.us-demo.internal"] },
      });
    return "";
  };
  await createAdministrativePostgres(resources, command, async () => {});
  assert.equal(
    created.some((arg) => /uid=|gid=/.test(arg)),
    false,
  );
  assert.equal(created[created.indexOf("--user") + 1], "0:0");
  assert.deepEqual(
    created.flatMap((arg, index) => (arg === "--cap-add" ? [created[index + 1]] : [])),
    ["CHOWN", "SETUID", "SETGID"],
  );
  assert.ok(
    created.some((arg) => arg.includes("exec gosu postgres:postgres docker-entrypoint.sh")),
  );
  assert.ok(created.includes("--security-opt=no-new-privileges"));
});

test("live Postgres must be UID/GID70 with zero effective capabilities and no-new-privileges", async () => {
  const { spawnSync } = await import("node:child_process");
  const valid =
    "Uid:\t70\t70\t70\t70\nGid:\t70\t70\t70\t70\nCapEff:\t0000000000000000\nNoNewPrivs:\t1\n";
  for (const input of [
    valid,
    valid.replace("Uid:\t70", "Uid:\t0"),
    valid.replace("Gid:\t70", "Gid:\t0"),
    valid.replace("0000000000000000", "0000000000000001"),
    valid.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
  ]) {
    const result = spawnSync("awk", [administrativePostgresCredentialAwk], {
      input,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, input === valid ? 0 : 1);
  }
});

test("private PG membership requires exactly its owned network ID and DNS alias rather than generic mode", () => {
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const network = { owner, name: owner + "-network", id: "b".repeat(64) };
  const endpoint = { NetworkID: network.id, Aliases: ["postgres.us-demo.internal"] };
  assert.doesNotThrow(() =>
    assertAdministrativePostgresNetwork(
      JSON.stringify({ [network.name]: endpoint }),
      network,
      true,
    ),
  );
  assert.doesNotThrow(() =>
    assertAdministrativePostgresNetwork(
      JSON.stringify({ [network.name]: { ...endpoint, NetworkID: "" } }),
      network,
      false,
    ),
  );
  for (const value of [
    { bridge: endpoint },
    { [network.name]: { ...endpoint, NetworkID: "c".repeat(64) } },
    { [network.name]: { ...endpoint, NetworkID: "" } },
    { [network.name]: { ...endpoint, Aliases: ["wrong.invalid"] } },
    { [network.name]: endpoint, bridge: endpoint },
  ])
    assert.throws(
      () => assertAdministrativePostgresNetwork(JSON.stringify(value), network, true),
      /us_hosted_admin_fixture_invalid/,
    );
});

test("native holder checks use exact private endpoints without requiring the PG alias", async () => {
  const { assertAdministrativeHolderNetwork } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  assert.equal(typeof assertAdministrativeHolderNetwork, "function");
  const owner = "us-admin-preflight-11111111-1111-4111-8111-111111111111";
  const expected = { owner, name: owner + "-network", id: "b".repeat(64) };
  const valid = { [expected.name]: { NetworkID: expected.id, Aliases: null } };
  assert.doesNotThrow(() => assertAdministrativeHolderNetwork(JSON.stringify(valid), expected));
  for (const value of [
    {},
    { bridge: valid[expected.name] },
    { ...valid, bridge: valid[expected.name] },
    { [expected.name]: { NetworkID: "" } },
    { [expected.name]: { NetworkID: "c".repeat(64) } },
  ])
    assert.throws(
      () => assertAdministrativeHolderNetwork(JSON.stringify(value), expected),
      /us_hosted_admin_fixture_invalid/,
    );
});

test("regression fixture grants only CHOWN to runtime material preparation, with all other capabilities dropped", async () => {
  const { administrativeRegressionHolderSecurity } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  assert.equal(typeof administrativeRegressionHolderSecurity, "function");
  for (const service of [
    "api",
    "worker",
    "migrate",
    "seed",
    "provision",
    "wrongSupplementEntry",
    "wrongDescriptor",
  ]) {
    const args = administrativeRegressionHolderSecurity(service);
    assert.ok(Object.isFrozen(args));
    assert.ok(args.includes("--cap-drop=ALL"));
    assert.ok(args.includes("--security-opt=no-new-privileges"));
    assert.deepEqual(
      args.filter((x) => x.startsWith("--cap-add=")),
      ["api", "worker"].includes(service) ? ["--cap-add=CHOWN"] : [],
    );
  }
  for (const x of [undefined, "root", "api --privileged", {}])
    assert.throws(
      () => administrativeRegressionHolderSecurity(x),
      /us_hosted_admin_fixture_invalid/,
    );
});

test("regression PID1 remains nonroot with zero effective capabilities before and after root material preparation", async () => {
  const { administrativeRegressionHolderPrivilegeProgram } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  const { runInNewContext } = await import("node:vm");
  assert.equal(typeof administrativeRegressionHolderPrivilegeProgram, "string");
  const valid =
    "Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\nCapInh:\t0000000000000000\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapAmb:\t0000000000000000\nCapBnd:\t0000000000000001\nNoNewPrivs:\t1\n";
  for (const input of [
    valid,
    valid.replace("Uid:\t10001", "Uid:\t0"),
    valid.replace("Gid:\t10001", "Gid:\t0"),
    ...["CapInh", "CapPrm", "CapEff", "CapAmb"].map((key) =>
      valid.replace(key + ":\t0000000000000000", key + ":\t0000000000000001"),
    ),
    valid.replace("CapBnd:\t0000000000000001", "CapBnd:\t0000000000000003"),
    valid.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
  ]) {
    let output = "";
    const invoke = () =>
      runInNewContext(administrativeRegressionHolderPrivilegeProgram, {
        require: (name) => {
          assert.equal(name, "node:fs");
          return {
            readFileSync: (path, encoding) => {
              assert.equal(path, "/proc/1/status");
              assert.equal(encoding, "utf8");
              return input;
            },
          };
        },
        process: { stdout: { write: (text) => (output += text) } },
      });
    if (input === valid) {
      invoke();
      assert.equal(output, "[1]\n");
    } else assert.throws(invoke, /us_hosted_admin_fixture_invalid/);
  }
});

test("runtime regression bootstrap clears inherited and ambient capabilities before Node using the pinned local utility", async () => {
  const { administrativeRegressionRuntimeBootstrap } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  assert.deepEqual(administrativeRegressionRuntimeBootstrap, [
    "/usr/bin/setpriv",
    "--ambient-caps=-all",
    "--inh-caps=-all",
    "node",
  ]);
  assert.ok(Object.isFrozen(administrativeRegressionRuntimeBootstrap));
});

test("native diagnostic stderr admits only bounded fixed phases and monotonic numbers, never arbitrary fields", async () => {
  const { parseAdministrativeNativePhase } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  assert.equal(typeof parseAdministrativeNativePhase, "function");
  const good = { phase: "release_begin", elapsedMs: 12.5 };
  assert.deepEqual(parseAdministrativeNativePhase("US_ADMIN_PHASE " + JSON.stringify(good)), good);
  for (const line of [
    "private text",
    "US_ADMIN_PHASE invalid",
    "US_ADMIN_PHASE " + JSON.stringify({ ...good, password: "private" }),
    "US_ADMIN_PHASE " + JSON.stringify({ ...good, phase: "private" }),
    "US_ADMIN_PHASE " + JSON.stringify({ ...good, elapsedMs: -1 }),
    "US_ADMIN_PHASE " + JSON.stringify({ ...good, elapsedMs: 30001 }),
    "US_ADMIN_PHASE " + "x".repeat(512),
  ])
    assert.equal(parseAdministrativeNativePhase(line), undefined);
});

test("native phase evidence survives a failed client after the case budget ends and discards raw stderr", async () => {
  const { readFile } = await import("node:fs/promises");
  const { stripTypeScriptTypes } = await import("node:module");
  const { runInNewContext } = await import("node:vm");
  const { EventEmitter } = await import("node:events");
  const { parseAdministrativeNativePhase } =
    await import("../../../apps/api/test/support/us-hosted-admin-preflight-fixture.mjs");
  const source = await readFile(
    new URL(
      "../../../apps/api/test/us-hosted-admin-preflight-installed.e2e.test.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("function client("),
    source.indexOf('\nit("requires distinct'),
  );
  const output = [],
    active = new Set();
  let callback,
    tick = 0;
  const child = {
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end() {} }),
  };
  const client = runInNewContext(stripTypeScriptTypes(body) + "\nclient", {
    Buffer,
    performance: { now: () => ++tick },
    active,
    parsePhase: parseAdministrativeNativePhase,
    invalid: () => new Error("native_invalid"),
    process: { stderr: { write: (line) => output.push(line) } },
    execFile: (command, args, options, cb) => {
      assert.equal(command, "docker");
      assert.equal(options.timeout, 5000);
      callback = cb;
      return child;
    },
  });
  const promise = client(["exec"], "fixed synthetic program", true);
  assert.equal(
    await Promise.race([promise, Promise.resolve("case_budget_ended")]),
    "case_budget_ended",
  );
  child.stderr.emit(
    "data",
    Buffer.from(
      'private diagnostic error\nUS_ADMIN_PHASE {"phase":"release_begin","elapsedMs":2}\n',
    ),
  );
  child.stderr.emit(
    "data",
    Buffer.from('US_ADMIN_PHASE {"phase":"release_end","elapsedMs":3,"password":"private"}\n'),
  );
  callback(new Error("private native error"), "private stdout");
  await assert.rejects(promise, /native_invalid/);
  assert.equal(active.size, 0);
  const records = output.map((line) => parseAdministrativeNativePhase(line.trimEnd()));
  assert.deepEqual(
    records.map((x) => x.phase),
    ["host_dispatch", "host_first_guest_marker", "release_begin", "host_completed_error"],
  );
  assert.ok(!output.join("").includes("private"));
});
