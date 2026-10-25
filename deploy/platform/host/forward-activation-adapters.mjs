import { canonical, ensure } from "../backup/schemas.mjs";
import { withHeldForwardState } from "./forward-state.mjs";
import { createUpgradeHostAdapters } from "./command.mjs";
import { createUpgradeHostObservers, observerProducer } from "./observe.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { runHostProcess } from "./process.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
// Trusted installed constructors only. Each method consumes a different guarded
// capability; no JSON callback, ambient capability or reusable held token exists.
export function createForwardActivationAdapters(
  loaded,
  oldOperation,
  verifyReleaseHeld,
  verifiedBackup,
  options = {},
) {
  const { record } = loaded,
    op = record.operation;
  const candidate = {
    root: op.root,
    dockerConfig: op.dockerConfig,
    identity: op.admission.identity,
    configuration: op.configuration,
    preparedTarget: op.preparedTarget,
    preparedPolicy: op.preparedPolicy,
  };
  const probeCleanups = new Set();
  const registerProbeCleanup = (cleanup) => {
    probeCleanups.add(cleanup);
    return () => probeCleanups.delete(cleanup);
  };
  let releaseVerified = false,
    terminated = true;
  const action = (context, cap, callback, cleanup = false) =>
    withHeldForwardState(cap, async (held) => {
      ensure(terminated && (held.cleanup === true) === Boolean(cleanup));
      same(held.state.admission, op.admission);
      same(held.state.decision, op.decision);
      same(held.state.sourceRuntime.containers, op.predecessorContainers);
      same(held.state.admission.originalPredecessor.identity, oldOperation.identity);
      same(context.identity, candidate.identity);
      same(context.configuration, candidate.configuration);
      ensure(
        context.phase === held.state.phase &&
          held.state.decision.phase === "post-migration-activate",
      );
      if (cleanup) {
        ensure(held.state.status === "recovery-required");
        if (cleanup === "workloads") ensure(held.state.migrationEntered);
      }
      const verify = async () => {
        ensure(terminated);
        await held.verify();
        await loaded.verifySources();
        await held.verify();
      };
      const runProcess = async (request, recheck) => {
        await verify();
        recheck?.();
        try {
          const result = await (options.runProcess ?? runHostProcess)(request, recheck);
          await verify();
          return result;
        } catch (error) {
          if (error?.terminationConfirmed === false) terminated = false;
          throw error;
        }
      };
      await verify();
      const dependencies = { ...options, runProcess, registerProbeCleanup };
      let result;
      if (cleanup) {
        const observers = createUpgradeHostObservers(
          candidate,
          oldOperation,
          op.predecessorContainers,
          record.observationPolicy,
          dependencies,
        );
        result = await callback({ held, verify, observers });
      } else {
        const verified = await readVerifiedBackup({
          root: op.root,
          identity: candidate.identity,
          ...op.preparedPolicy,
        });
        same(verified.backupProof, held.state.backup);
        const adapters = await createUpgradeHostAdapters(
          {
            ...loaded,
            verified,
            verifySources: verify,
            record: { ...record, deployment: candidate },
          },
          oldOperation,
          op.predecessorContainers,
          dependencies,
        );
        result = await callback({ held, verify, adapters });
      }
      await verify();
      return result;
    });
  const invoke = (name) => (context, cap) =>
    action(context, cap, ({ adapters }) => adapters[name](context));
  return Object.freeze({
    verifyRelease: (context, cap) =>
      action(context, cap, async ({ held, adapters }) => {
        await verifyReleaseHeld(held);
        await adapters.verifyRoles(context);
        releaseVerified = true;
      }),
    verifyImages: invoke("verifyImages"),
    verifyRoles: invoke("verifyRoles"),
    inspectTarget: invoke("inspectTarget"),
    smoke: invoke("smoke"),
    writerFence: {
      producerId: observerProducer,
      executorSha: candidate.identity.executorSha,
      observe: (context, cap) =>
        action(context, cap, async ({ adapters }) => {
          if (releaseVerified) await adapters.verifyRoles(context);
          return adapters.writerFence.observe(context);
        }),
    },
    workload: {
      identity: structuredClone({ resources: verifiedBackup.evidence.cleanup.resources }),
      producerId: observerProducer,
      executorSha: candidate.identity.executorSha,
      inspect: (context, cap) =>
        action(context, cap, ({ adapters }) => adapters.workload.inspect(context)),
    },
    cleanupOwnedProbes: async (context, cap) => {
      try {
        return await action(
          context,
          cap,
          async ({ observers }) => {
            for (const cleanup of probeCleanups) await cleanup(observers.command);
            ensure(probeCleanups.size === 0);
          },
          "probes",
        );
      } catch (error) {
        // No fresh phase may proceed while an owned probe could remain. A failed
        // integrity check or uncertain cleanup retains the shared operation lock.
        error.durabilityUncertain = true;
        throw error;
      }
    },
    cleanupOwnedWorkloads: (context, cap) =>
      action(
        context,
        cap,
        async ({ observers }) => {
          const recovery = {
            ...context,
            boundary: "recovery",
            allowedServices: ["postgres", "api", "edge"],
          };
          for (const service of ["edge", "api"]) {
            const state = await observers.inventory(recovery);
            const row = state.owned.find((r) => r.service === service);
            // Exact retained IDs and PostgreSQL can never be cleanup targets.
            // New candidate apps must satisfy the complete observed recipe.
            if (row && row.container.Id !== op.predecessorContainers[service] && row.active)
              await observers.command(
                ["container", "stop", "--time", "10", row.container.Id],
                true,
              );
          }
          const state = await observers.inventory(recovery);
          ensure(state.owned.every((r) => r.service === "postgres" || !r.active));
        },
        "workloads",
      ),
  });
}
