import { forwardRecipePredecessorIds } from "./forward-history.mjs";
import { canonical, ensure, hash, keys } from "../backup/schemas.mjs";
import { snapshotActivation } from "./recovery-activation-admission.mjs";
import { withHeldForwardState } from "./forward-state.mjs";
import { readUpgradePredecessor } from "./upgrade-state.mjs";
import { createUpgradeHostObservers, guarded } from "./observe.mjs";
import { observePostgresAdmin } from "./probe.mjs";
import { fingerprintHostConfiguration } from "./config.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { validateCatalogConfig } from "../catalog-config.mjs";
import {
  observeForwardMigrationLedger,
  validateProductMigrationLedger,
} from "./forward-ledger.mjs";
import { runHostProcess } from "./process.mjs";
const same = (a, b) => ensure(canonical(a) === canonical(b));
const active = (c) => c.State.Running || c.State.Restarting || c.State.Paused;
const stages = ["activation-admitted", "api-started", "edge-started", "healthy"];
function physicalObserver(input, dependencies) {
  const { oldOperation, candidateOperation, retainedIds, baseline, policy } = snapshotActivation({
    oldOperation: input.oldOperation,
    candidateOperation: input.candidateOperation,
    retainedIds: input.retainedIds,
    baseline: input.baseline,
    policy: input.policy,
  });
  const productMigrationProof = input.productMigrationProof;
  ensure(typeof dependencies.verifySources === "function" && hash(dependencies.hbaSha256));
  keys(retainedIds, ["postgres", "api", "edge"]);
  same(retainedIds, baseline.containers);
  validateProductMigrationLedger(
    productMigrationProof.entries.map(({ hash, createdAt }) => ({ hash, createdAt })),
    productMigrationProof,
  );
  ensure(
    productMigrationProof.proofSha256 === baseline.productMigrationProofSha256 &&
      productMigrationProof.productSha ===
        candidateOperation.identity.admission.manifest.sourceSha &&
      productMigrationProof.imageId ===
        candidateOperation.identity.admission.registry.api.imageId &&
      productMigrationProof.imageReference === candidateOperation.identity.admission.manifest.api,
  );
  const candidateIds = new Map();
  let terminated = true;
  return async ({ root, admission, state, cleanup = false }, verifyAuthority) => {
    ensure(
      terminated &&
        root === candidateOperation.root &&
        root === oldOperation.root &&
        candidateOperation.dockerConfig === `${root}/docker` &&
        oldOperation.dockerConfig === `${root}/docker`,
    );
    same(candidateOperation.identity, admission.identity);
    same(oldOperation.identity, admission.originalPredecessor.identity);
    same(baseline, admission.baseline);
    const predecessor = JSON.parse(
      (await readUpgradePredecessor(root, admission.originalPredecessor.identity))
        .activationOperation,
    );
    same(oldOperation.configuration, predecessor.operation.activation.configuration);
    same(policy, predecessor.observationPolicy);
    const phase = state?.phase ?? "admitted",
      status = state?.status ?? "entered";
    const candidate = state?.decision?.phase === "post-migration-activate";
    ensure(
      candidate
        ? stages.includes(phase)
        : ["admitted", "source-held", "backup-verified"].includes(phase),
    );
    const verify = async () => {
      ensure(terminated);
      await verifyAuthority();
      await dependencies.verifySources();
      for (const [operation, expected] of [
        [oldOperation, admission.oldConfigurationSha256],
        [candidateOperation, admission.candidateConfigurationSha256],
      ])
        ensure(
          (await fingerprintHostConfiguration({ root, ...operation.configuration }))
            .configurationSha256 === expected,
        );
    };
    await verify();
    const oldEnv = await readProtectedEnv(oldOperation.configuration.runtimeSnapshot.path),
      env = await readProtectedEnv(candidateOperation.configuration.runtimeSnapshot.path);
    for (const key of [
      "MARKIRO_POSTGRES_IMAGE_DIGEST",
      "MARKIRO_POSTGRES_SERVER_CERT_FILE",
      "MARKIRO_POSTGRES_SERVER_KEY_FILE",
      "MARKIRO_POSTGRES_PASSWORD_FILE",
      "MARKIRO_POSTGRES_CA_FILE",
    ])
      same(env[key], oldEnv[key]);
    ensure(
      typeof env.MARKIRO_RELEASES_DOMAIN === "string" &&
        env.MARKIRO_RELEASES_DOMAIN.length > 0 &&
        typeof env.MARKIRO_RELEASES_BUCKET === "string" &&
        env.MARKIRO_RELEASES_BUCKET.length > 0,
    );
    if (validateCatalogConfig(env)) ensure(env.RELEASE_CATALOG_WRITERS_ENABLED === "false");
    const runProcess = async (request) => {
      await verify();
      try {
        const result = await (dependencies.runProcess ?? runHostProcess)(request);
        await verify();
        return result;
      } catch (error) {
        if (error?.terminationConfirmed === false) terminated = false;
        throw error;
      }
    };
    const observers = createUpgradeHostObservers(
      candidateOperation,
      oldOperation,
      forwardRecipePredecessorIds(admission),
      policy,
      { ...dependencies, runProcess },
    );
    const allowedServices = [
      "postgres",
      ...(candidate && stages.indexOf(phase) >= 1 ? ["api"] : []),
      ...(candidate && stages.indexOf(phase) >= 2 ? ["edge"] : []),
    ];
    const context = {
      root,
      identity: candidateOperation.identity,
      configuration: candidateOperation.configuration,
      allowedServices,
      phase,
      boundary: cleanup ? "recovery" : "entry",
      previousHealthy: null,
      migration: { name: `markiro-platform-migrate-${candidateOperation.identity.operationId}` },
    };
    const observed = await observers.inventory(context);
    ensure(
      !observed.containerNames.some(({ name }) =>
        /^\/markiro-(?:platform-(?:probe|migrate)|backup|restore)(?:-|$)/u.test(name),
      ),
    );
    ensure(
      observed.owned.length === 3 &&
        observed.owned.every((row) => ["postgres", "api", "edge"].includes(row.service)),
    );
    const containers = {};
    for (const row of observed.owned) {
      const { service, container } = row;
      ensure(!Object.hasOwn(containers, service));
      containers[service] = container.Id;
      if (service === "postgres") {
        ensure(
          container.Id === retainedIds.postgres &&
            active(container) &&
            container.State.Running &&
            !container.State.Restarting &&
            !container.State.Paused &&
            container.State.Health?.Status === "healthy",
        );
        continue;
      }
      const retained = container.Id === retainedIds[service];
      if (!candidate) ensure(retained && !active(container));
      else {
        const required = service === "api" ? 1 : 2,
          current = stages.indexOf(phase);
        if (retained)
          ensure(
            !active(container) &&
              (current < required || (current === required && (status === "entered" || cleanup))),
          );
        else {
          ensure(current >= required && !Object.values(retainedIds).includes(container.Id));
          if (candidateIds.has(service)) ensure(candidateIds.get(service) === container.Id);
          else candidateIds.set(service, container.Id);
          if (!cleanup)
            ensure(
              container.State.Running &&
                !container.State.Paused &&
                !container.State.Restarting &&
                (service !== "api" || container.State.Health?.Status === "healthy"),
            );
        }
      }
      if (service === "edge")
        same(container.HostConfig.PortBindings, {
          "8080/tcp": [{ HostIp: "", HostPort: "80" }],
          "8443/tcp": [{ HostIp: "", HostPort: "443" }],
        });
    }
    keys(containers, ["postgres", "api", "edge"]);
    await observePostgresAdmin({
      context,
      state: observed,
      command: observers.command,
      hbaSha256: dependencies.hbaSha256,
    });
    const ledger = await observeForwardMigrationLedger({
      postgresId: retainedIds.postgres,
      proof: productMigrationProof,
      root,
      runProcess,
    });
    same(ledger.schema, baseline.schema);
    ensure(ledger.schema.systemId === admission.identity.target.databaseId);
    await verify();
    return { containers, ledger, phase, candidate };
  };
}
// Read-only pre-ownership verifier for the trusted store constructor. It cannot
// issue a capability or mutate Docker/SQL; loader supplies fixed full authority.
export function createForwardBaselineVerifier(input, dependencies = {}) {
  const inspect = physicalObserver(input, dependencies);
  return async (request) => {
    await inspect(request, dependencies.verifySources);
  };
}
export function createForwardObservers(input, dependencies = {}) {
  const inspect = physicalObserver(input, dependencies);
  const action = (mode, cap) =>
    guarded(() =>
      withHeldForwardState(cap, async (held) => {
        ensure(held.state.migrationEntered === true);
        if (mode === "source") ensure(!held.state.decision);
        if (mode === "candidate") ensure(held.state.decision?.phase === "post-migration-activate");
        const result = await inspect(
          {
            root: held.root,
            admission: held.state.admission,
            state: held.state,
            cleanup: held.cleanup,
          },
          held.verify,
        );
        if (mode === "schema") return result.ledger;
        if (mode === "source")
          return snapshotActivation({
            version: 1,
            kind: "platform-forward-source-runtime",
            operationId: held.state.admission.identity.operationId,
            configurationSha256: held.state.admission.candidateConfigurationSha256,
            containers: result.containers,
            schema: result.ledger.schema,
            productMigrationProofSha256: result.ledger.productProofSha256,
          });
        return snapshotActivation({
          version: 1,
          kind: "platform-forward-observation",
          operationId: held.state.admission.identity.operationId,
          configurationSha256: held.state.admission.candidateConfigurationSha256,
          target: held.state.admission.identity.target,
          phase: result.phase,
          containers: result.containers,
          schema: result.ledger.schema,
          productMigrationProofSha256: result.ledger.productProofSha256,
        });
      }),
    );
  return Object.freeze({
    inspectSource: (cap) => action("source", cap),
    inspectCandidate: (cap) => action("candidate", cap),
    inspectSchema: (cap) => action("schema", cap),
  });
}
