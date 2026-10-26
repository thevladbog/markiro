import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { forwardPreparationFixture } from "./forward-preparation-fixture.mjs";
import { executeForwardPreparation } from "../host/forward-preparation.mjs";
import { forwardDecision } from "./forward-fixture.mjs";
import { withHeldForwardState } from "../host/forward-state.mjs";
import {
  runPreparedForwardCommand,
  runPreparedForwardBoundary,
} from "../host/forward-activation-adapters.mjs";
export async function forwardActivationFixture(t, failAt) {
  const f = await forwardPreparationFixture(t);
  await executeForwardPreparation(f.context, f.adapters, f.options);
  const journal = join(
    f.root,
    "forward-recovery-operations",
    f.input.identity.operationId,
    "state.json",
  );
  const prior = JSON.parse(await readFile(journal)),
    decision = forwardDecision(f, prior);
  const directory = join(
    dirname(f.root),
    "upgrade-operations",
    f.input.identity.operationId,
    "post-migration-activate",
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const { writerFence, workload, root, identity, configuration, ...preparedPolicy } = f.p.expected;
  const input = {
    root,
    dockerConfig: f.p.dockerConfig,
    decision,
    configuration,
    preparedTarget: f.p.record,
    preparedPolicy,
  };
  const ids = { ...f.input.baseline.containers },
    old = { ...ids },
    active = { api: false, edge: false },
    trace = [],
    commands = [],
    cleanupIds = [];
  const ledger = {
    version: 1,
    kind: "platform-forward-migration-observation",
    postgresId: ids.postgres,
    productProofSha256: f.productMigrationProof.proofSha256,
    schema: structuredClone(f.input.baseline.schema),
    rows: f.productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
  };
  let projectionChecks = 0;
  const action = (name, context, cap, fn) =>
    withHeldForwardState(cap, async (held) => {
      assert.equal(context.phase, held.state.phase);
      trace.push(name);
      if (name === failAt) throw new Error("PRIVATE-FORWARD-ACTIVATION-FAILURE");
      return fn(held);
    });
  const inspectTarget = (ctx) => {
    if (ctx.phase === "api-started" && ["entry", "command"].includes(ctx.boundary)) {
      assert.equal(
        active.api,
        false,
        "retained projection must not be compared after candidate writers start",
      );
      projectionChecks++;
      if (failAt === "projection") throw new Error("projection changed");
    }
    return {
      target: identity.target,
      project: "markiro-platform",
      serverProfile: "platform-only",
      uiProfile: "platform-only",
      os: "linux",
      architecture: "amd64",
    };
  };
  const observers = {
    inspectTarget,
    writerFence: {
      ...writerFence,
      observe: async (request) => ({
        ...(await writerFence.observe(request)),
        observedAt: new Date(Date.now()).toISOString(),
      }),
    },
    workload: {
      ...workload,
      inspect: async (request) => ({
        ...(await workload.inspect(request)),
        observedAt: new Date(Date.now()).toISOString(),
      }),
    },
  };
  const adapters = {
    verifyRelease: (ctx, cap) => action("verifyRelease", ctx, cap, () => {}),
    verifyImages: (ctx, cap) => action("verifyImages", ctx, cap, () => {}),
    verifyRoles: (ctx, cap) => action("verifyRoles", ctx, cap, () => {}),
    inspectSchema: (ctx, cap) => action("inspectSchema", ctx, cap, () => structuredClone(ledger)),
    inspectCandidate: (ctx, cap) =>
      action("inspectCandidate", ctx, cap, () => ({
        version: 1,
        kind: "platform-forward-observation",
        operationId: identity.operationId,
        configurationSha256: identity.configurationSha256,
        target: identity.target,
        phase: ctx.phase,
        containers: { ...ids },
        schema: f.input.baseline.schema,
        productMigrationProofSha256: f.productMigrationProof.proofSha256,
      })),
    inspectTarget: (ctx, cap) => action("inspectTarget", ctx, cap, () => inspectTarget(ctx)),
    smoke: (ctx, cap) => action("smoke", ctx, cap, () => {}),
    writerFence: {
      ...writerFence,
      observe: (ctx, cap) => action("writerFence", ctx, cap, () => writerFence.observe(ctx)),
    },
    workload: {
      ...workload,
      inspect: (ctx, cap) => action("workload", ctx, cap, () => workload.inspect(ctx)),
    },
    withPreparedBoundary: (ctx, cap, callback) =>
      action("withPreparedBoundary", ctx, cap, (held) =>
        runPreparedForwardBoundary({ ...input, identity }, ctx, observers, held.verify, callback),
      ),
    withPreparedCommand: (ctx, cap, command) =>
      action("withPreparedCommand", ctx, cap, (held) =>
        runPreparedForwardCommand({ ...input, identity }, ctx, observers, held.verify, command),
      ),
    cleanupOwnedProbes: (ctx, cap) =>
      action("cleanupOwnedProbes", ctx, cap, (held) => {
        assert.equal(held.cleanup, true);
      }),
    cleanupOwnedWorkloads: (ctx, cap) =>
      action("cleanupOwnedWorkloads", ctx, cap, (held) => {
        assert.equal(held.cleanup, true);
        for (const service of ["edge", "api"])
          if (active[service] && ids[service] !== old[service]) {
            assert.ok(!Object.values(old).includes(ids[service]));
            cleanupIds.push(ids[service]);
            active[service] = false;
          }
      }),
    runProcess: async (request, recheck) => {
      recheck();
      assert.equal(request.executable, "/usr/bin/docker");
      assert.equal(request.env.DATABASE_URL, undefined);
      const args = request.args,
        service = args.at(-1);
      assert.ok(["api", "edge"].includes(service));
      assert.ok(args.includes("up"));
      assert.equal(
        args.some((arg) => ["run", "migrate", "postgres", "start", "stop", "rm"].includes(arg)),
        false,
      );
      commands.push(service);
      trace.push(`${service}-up`);
      ids[service] = (service === "api" ? "6" : "7").repeat(64);
      active[service] = true;
      if (failAt === service)
        throw Object.assign(new Error("PRIVATE-COMPOSE-FAILURE"), { terminationConfirmed: true });
    },
  };
  return {
    ...f,
    input,
    prior,
    decision,
    journal,
    directory,
    adapters,
    observers,
    ids,
    old,
    active,
    ledger,
    trace,
    commands,
    cleanupIds,
    projectionChecks: () => projectionChecks,
  };
}
