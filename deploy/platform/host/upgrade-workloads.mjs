import { canonical, ensure } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withHeldUpgradeState } from "./upgrade-state.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import { createAcceptedRecoveryObservers, guarded } from "./observe.mjs";
import { runHostProcess } from "./process.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const active = (c) => c.State.Running || c.State.Restarting || c.State.Paused;
// Only the verified installed runtime constructs this adapter. It never accepts
// a command, selector or cleanup list from JSON. The lifetime-bound capability
// and full old authority are rechecked around every daemon await.
export function createUpgradeWorkloadCommands(input, dependencies = {}) {
  const { oldOperation, candidateOperation, predecessorContainers, policy } = snapshotActivation({
    oldOperation: input.oldOperation,
    candidateOperation: input.candidateOperation,
    predecessorContainers: input.predecessorContainers,
    policy: input.policy,
  });
  ensure(typeof dependencies.verifySources === "function");
  const started = new Set();
  let terminated = true;
  const heldAction = (cap, action) =>
    guarded(() =>
      withHeldUpgradeState(cap, async (held) => {
        ensure(terminated && !held.state.migrationEntered);
        same(held.state.admission.identity, candidateOperation.identity);
        same(held.state.admission.predecessor.identity, oldOperation.identity);
        same(held.predecessor.operation.activation.configuration, oldOperation.configuration);
        same(held.predecessor.observationPolicy, policy);
        same(held.state.oldRuntime.containers, predecessorContainers);
        const verify = async () => {
          ensure(terminated);
          await held.verify();
          await dependencies.verifySources();
          for (const [op, hash] of [
            [oldOperation, held.state.admission.oldConfigurationSha256],
            [candidateOperation, held.state.admission.candidateConfigurationSha256],
          ])
            ensure(
              (await fingerprintHostConfiguration({ root: held.root, ...op.configuration }))
                .configurationSha256 === hash,
            );
          await held.verify();
        };
        const observer = createAcceptedRecoveryObservers(oldOperation, policy, {
          ...dependencies,
          runProcess: async (request) => {
            await verify();
            try {
              const result = await (dependencies.runProcess ?? runHostProcess)(request);
              await verify();
              return result;
            } catch (error) {
              if (error?.terminationConfirmed === false) terminated = false;
              throw error;
            }
          },
        });
        const inspect = async () => {
          await verify();
          const state = await observer.inventory({
            identity: oldOperation.identity,
            configuration: oldOperation.configuration,
            allowedServices: ["postgres", "api", "edge"],
            phase: held.state.phase,
            boundary: held.cleanup ? "recovery" : "entry",
            previousHealthy: null,
          });
          ensure(state.owned.length === 3);
          for (const service of ["postgres", "api", "edge"]) {
            const rows = state.owned.filter((r) => r.service === service);
            ensure(rows.length === 1 && rows[0].container.Id === predecessorContainers[service]);
          }
          const pg = state.owned.find((r) => r.service === "postgres").container;
          ensure(pg.State.Running && !pg.State.Paused && !pg.State.Restarting);
          await verify();
          return state;
        };
        return action({ held, observer, inspect, verify });
      }),
    );
  const stop = (service, cap) =>
    heldAction(cap, async ({ held, observer, inspect }) => {
      ensure(
        !held.cleanup && held.state.phase === "old-stopped" && held.state.status === "entered",
      );
      const state = await inspect();
      if (service === "api")
        ensure(!active(state.owned.find((r) => r.service === "edge").container));
      const row = state.owned.find((r) => r.service === service);
      if (active(row.container))
        await observer.command([
          "container",
          "stop",
          "--time",
          "10",
          predecessorContainers[service],
        ]);
      ensure(!active((await inspect()).owned.find((r) => r.service === service).container));
    });
  const start = (service, cap) =>
    heldAction(cap, async ({ held, observer, inspect }) => {
      ensure(
        !held.cleanup &&
          held.state.phase === (service === "api" ? "old-api-started" : "old-edge-started") &&
          held.state.status === "entered",
      );
      const state = await inspect(),
        row = state.owned.find((r) => r.service === service);
      if (service === "edge") {
        const api = state.owned.find((r) => r.service === "api").container;
        ensure(api.State.Running && !api.State.Restarting && !api.State.Paused);
      }
      if (!active(row.container)) {
        // Intent precedes the daemon call: a known failure can still have started
        // this exact ID. Unknown termination blocks every subsequent command.
        started.add(predecessorContainers[service]);
        await observer.command(["container", "start", predecessorContainers[service]]);
      }
      const result = (await inspect()).owned.find((r) => r.service === service).container;
      ensure(result.State.Running && !result.State.Restarting && !result.State.Paused);
    });
  return Object.freeze({
    stopOldEdge: (cap) => stop("edge", cap),
    stopOldApi: (cap) => stop("api", cap),
    startOldApi: (cap) => start("api", cap),
    startOldEdge: (cap) => start("edge", cap),
    verifyOldHealth: (cap) =>
      heldAction(cap, async ({ held, inspect }) => {
        ensure(
          !held.cleanup && held.state.phase === "returned-old" && held.state.status === "entered",
        );
        // Docker start returns before the healthcheck settles. Only "starting"
        // may be observed again; unhealthy, absent health or an exited process
        // fails immediately. Every poll retains full ID/config/phase authority.
        for (let attempt = 0; attempt < 120; attempt++) {
          const state = await inspect();
          for (const row of state.owned)
            ensure(
              row.container.State.Running &&
                !row.container.State.Restarting &&
                !row.container.State.Paused,
            );
          const health = ["postgres", "api"].map(
            (service) =>
              state.owned.find((row) => row.service === service).container.State.Health?.Status,
          );
          ensure(health.every((value) => value === "healthy" || value === "starting"));
          if (health.every((value) => value === "healthy")) return;
          ensure(attempt < 119);
          await (dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(
            500,
          );
        }
      }),
    cleanupOwnedStarts: (cap) =>
      heldAction(cap, async ({ held, observer, inspect }) => {
        ensure(
          held.cleanup === true &&
            held.state.status === "recovery-required" &&
            held.state.decision.phase === "return-old",
        );
        for (const service of ["edge", "api"]) {
          const state = await inspect(),
            row = state.owned.find((r) => r.service === service);
          if (started.has(row.container.Id) && active(row.container))
            await observer.command(["container", "stop", "--time", "10", row.container.Id], true);
        }
        const state = await inspect();
        ensure(state.owned.every((r) => !started.has(r.container.Id) || !active(r.container)));
      }),
  });
}
