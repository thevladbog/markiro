import { canonical, ensure, keys } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import {
  createUpgradeHostObservers,
  createAcceptedRecoveryObservers,
  guarded,
} from "./observe.mjs";
import { withHeldUpgradeState } from "./upgrade-state.mjs";
import { runHostProcess } from "./process.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { validateCatalogConfig, CATALOG_RUNTIME_KEYS } from "../catalog-config.mjs";

const same = (a, b) => ensure(canonical(a) === canonical(b));
const active = (c) => c.State.Running || c.State.Restarting || c.State.Paused;

// Dependencies are installed executable adapters, never fields from an envelope.
// Each inspection selects one complete authority; stopped old apps are never
// accepted under candidate env or mounts, including when both use the same image.
export function createUpgradeObservers(input, dependencies = {}) {
  const { oldOperation, candidateOperation, predecessorContainers, policy } = snapshotActivation({
    oldOperation: input.oldOperation,
    candidateOperation: input.candidateOperation,
    predecessorContainers: input.predecessorContainers,
    policy: input.policy,
  });
  keys(predecessorContainers, ["postgres", "api", "edge"]);
  ensure(
    Object.values(predecessorContainers).every((id) => /^[a-f0-9]{64}$/u.test(id)) &&
      new Set(Object.values(predecessorContainers)).size === 3,
  );
  const inspect = (mode, capability) =>
    guarded(() =>
      withHeldUpgradeState(capability, async (held) => {
        const { state, root, predecessor } = held;
        const admission = state.admission;
        if (state.oldRuntime) same(state.oldRuntime.containers, predecessorContainers);
        const candidate = mode === "candidate";
        if (candidate)
          ensure(
            state.migrationEntered &&
              ["migration-entered", "migrated", "api-started", "edge-started", "healthy"].includes(
                state.phase,
              ),
          );
        else if (mode === "return")
          ensure(
            !state.migrationEntered &&
              ["return-admitted", "old-api-started", "old-edge-started", "returned-old"].includes(
                state.phase,
              ),
          );
        else
          ensure(
            !state.migrationEntered &&
              ["admitted", "old-stopped", "backup-verified", "activation-admitted"].includes(
                state.phase,
              ),
          );
        same(oldOperation.identity, admission.predecessor.identity);
        same(candidateOperation.identity, admission.identity);
        same(oldOperation.configuration, predecessor.operation.activation.configuration);
        same(policy, predecessor.observationPolicy);
        for (const op of [oldOperation, candidateOperation])
          ensure(op.root === root && op.dockerConfig === `${root}/docker`);
        const verify = async () => {
          const current = await held.verify();
          same(current.state, state);
          for (const [op, expected] of [
            [oldOperation, admission.oldConfigurationSha256],
            [candidateOperation, admission.candidateConfigurationSha256],
          ])
            ensure(
              (await fingerprintHostConfiguration({ root, ...op.configuration }))
                .configurationSha256 === expected,
            );
        };
        await verify();
        const oldEnv = await readProtectedEnv(oldOperation.configuration.runtimeSnapshot.path);
        const candidateEnv = await readProtectedEnv(
          candidateOperation.configuration.runtimeSnapshot.path,
        );
        for (const key of [
          "MARKIRO_POSTGRES_IMAGE_DIGEST",
          "MARKIRO_POSTGRES_SERVER_CERT_FILE",
          "MARKIRO_POSTGRES_SERVER_KEY_FILE",
          "MARKIRO_POSTGRES_PASSWORD_FILE",
          "MARKIRO_POSTGRES_CA_FILE",
        ])
          same(oldEnv[key], candidateEnv[key]);
        for (const key of ["MARKIRO_RELEASES_DOMAIN", "MARKIRO_RELEASES_BUCKET"]) {
          ensure(!Object.hasOwn(oldEnv, key));
          ensure(typeof candidateEnv[key] === "string" && candidateEnv[key].trim().length > 0);
        }
        ensure(CATALOG_RUNTIME_KEYS.every((key) => !Object.hasOwn(oldEnv, key)));
        if (validateCatalogConfig(candidateEnv))
          ensure(candidateEnv.RELEASE_CATALOG_WRITERS_ENABLED === "false");
        const operation = candidate ? candidateOperation : oldOperation;
        const options = {
          ...dependencies,
          runProcess: async (request) => {
            await verify();
            const result = await (dependencies.runProcess ?? runHostProcess)(request);
            await verify();
            return result;
          },
        };
        const observer = candidate
          ? createUpgradeHostObservers(
              candidateOperation,
              oldOperation,
              predecessorContainers,
              policy,
              options,
            )
          : createAcceptedRecoveryObservers(operation, policy, options);
        const allowedServices = candidate
          ? [
              "postgres",
              ...(["migration-entered"].includes(state.phase) ? ["migrate"] : []),
              ...(["api-started", "edge-started", "healthy"].includes(state.phase) ? ["api"] : []),
              ...(["edge-started", "healthy"].includes(state.phase) ? ["edge"] : []),
            ]
          : mode === "stopped"
            ? ["postgres"]
            : ["postgres", "api", "edge"];
        const observed = await observer.inventory({
          identity: operation.identity,
          allowedServices,
          phase: state.phase,
          boundary: "entry",
          previousHealthy: null,
          migration: { name: `markiro-platform-migrate-${operation.identity.operationId}` },
        });
        const containers = {};
        for (const row of observed.owned) {
          ensure(!Object.hasOwn(containers, row.service));
          containers[row.service] = row.container.Id;
          if (!candidate || row.service === "postgres")
            ensure(row.container.Id === predecessorContainers[row.service]);
          else {
            const retained = row.container.Id === predecessorContainers[row.service];
            if (retained) {
              ensure(!active(row.container));
              const required = row.service === "api" ? "api-started" : "edge-started";
              const stages = [
                "migration-entered",
                "migrated",
                "api-started",
                "edge-started",
                "healthy",
              ];
              ensure(
                stages.indexOf(state.phase) < stages.indexOf(required) ||
                  (state.phase === required && state.status === "entered"),
              );
            } else ensure(!Object.values(predecessorContainers).includes(row.container.Id));
          }
          if (row.service === "edge")
            same(row.container.HostConfig.PortBindings, {
              "8080/tcp": [{ HostIp: "", HostPort: "80" }],
              "8443/tcp": [{ HostIp: "", HostPort: "443" }],
            });
          if (row.service === "postgres")
            ensure(
              row.container.State.Running &&
                !row.container.State.Paused &&
                !row.container.State.Restarting,
            );
          if (mode === "stopped") ensure(row.service === "postgres" || !active(row.container));
        }
        if (!candidate) same(containers, predecessorContainers);
        else
          ensure(
            ["postgres", "api", "edge"].every((service) => Object.hasOwn(containers, service)),
          );
        const systemId = String(
          (
            await observer.command([
              "exec",
              "--user",
              "70:70",
              "--env",
              "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
              "--env",
              "PGCONNECT_TIMEOUT=10",
              containers.postgres,
              "psql",
              "-X",
              "--no-password",
              "--username",
              "postgres",
              "--dbname",
              "markiro",
              "--tuples-only",
              "--no-align",
              "--command",
              "SELECT system_identifier::text FROM pg_control_system()",
            ])
          ).stdout,
        ).trim();
        ensure(systemId === admission.identity.target.databaseId);
        await verify();
        // Container/config/physical identity proof only. Schema, SQL policy and TLS
        // checks are separate preparation/return gates, never inferred from this.
        return snapshotActivation({
          version: 1,
          kind: "platform-upgrade-observation",
          operationId: admission.identity.operationId,
          configurationSha256: operation.identity.configurationSha256,
          target: operation.identity.target,
          phase: state.phase,
          containers,
        });
      }),
    );
  return Object.freeze({
    inspectOld: (cap) => inspect("old", cap),
    inspectStoppedOld: (cap) => inspect("stopped", cap),
    inspectCandidate: (cap) => inspect("candidate", cap),
    inspectReturnEligibility: (cap) => inspect("return", cap),
  });
}
