import { canonical, digest, ensure, hash, keys, plain } from "../backup/schemas.mjs";
import { carryHostFailure } from "./failure-diagnostic.mjs";
import { createPrivateDirectory, readPrivateFile, writePrivateFile } from "./files.mjs";
import { withHeldHostState, withHostState } from "./state.mjs";

const parent = "healthy-forward-rollouts";
const indexName = "upgrade-index.json";
const backupCapabilities = new WeakMap();
const document = (value) => Buffer.from(`${JSON.stringify(value)}\n`);
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);

export async function withHealthyForwardBackupState(capability, action) {
  const holder = backupCapabilities.get(capability);
  ensure(holder && !holder.pending && typeof action === "function");
  holder.pending = Promise.resolve().then(async () => {
    await holder.context.verify();
    const result = await action(holder.context);
    await holder.context.verify();
    return result;
  });
  holder.pending.catch(() => {});
  return holder.pending;
}

// Internal executor only: adapters must be compiled, bound to the approved
// operation and observe their boundaries independently of any request data.
export async function withHealthyForwardRollout(input, adapters) {
  const operation = plain(input);
  keys(operation, [
    "root",
    "operationId",
    "predecessorOperationId",
    "predecessorIndexSha256",
    ...(Object.hasOwn(operation, "predecessorKind") ? ["predecessorKind"] : []),
    "operationSha256",
    "executorSha",
    "backupRuntimeSha256",
    "postgresId",
  ]);
  const {
    root,
    operationId,
    predecessorOperationId,
    predecessorIndexSha256,
    predecessorKind = "platform-forward-recovery-index",
    operationSha256,
  } = operation;
  ensure(
    ["platform-forward-recovery-index", "platform-healthy-forward-rollout-index"].includes(
      predecessorKind,
    ),
  );
  ensure(
    uuid(operationId) && uuid(predecessorOperationId) && operationId !== predecessorOperationId,
  );
  ensure(hash(predecessorIndexSha256) && hash(operationSha256) && hash(operation.postgresId));
  ensure(
    typeof operation.executorSha === "string" &&
      /^[a-f0-9]{40}$/u.test(operation.executorSha) &&
      hash(operation.backupRuntimeSha256),
  );
  for (const method of [
    "verifyAuthority",
    "preflight",
    "stopSource",
    "verifySourceStopped",
    "verifyBackup",
    "activateApi",
    "activateEdge",
    "verifyHealth",
  ])
    ensure(typeof adapters?.[method] === "function");

  return withHostState(root, (store) =>
    store.guardPersistence((capability) =>
      withHeldHostState(capability, async () => {
        const directory = `${parent}/${operationId}`;
        const stateName = `${directory}/state.json`;
        const archive = `${directory}/predecessor-index.json`;
        const predecessorBytes = await readPrivateFile(root, indexName);
        const predecessor = JSON.parse(predecessorBytes);
        ensure(
          digest(predecessorBytes) === predecessorIndexSha256 &&
            predecessor.kind === predecessorKind &&
            predecessor.operationId === predecessorOperationId,
        );
        const verifyPredecessor = async () => {
          await adapters.verifyAuthority();
          ensure((await readPrivateFile(root, indexName)).equals(predecessorBytes));
        };
        await verifyPredecessor();
        await adapters.preflight();
        await verifyPredecessor();
        await createPrivateDirectory(root, parent, { exclusive: false });
        await createPrivateDirectory(root, directory);
        await writePrivateFile(root, archive, predecessorBytes);

        let state;
        let workloadMutationAttempted = false;
        const check = async () => {
          await verifyPredecessor();
          ensure((await readPrivateFile(root, archive)).equals(predecessorBytes));
          if (state) ensure((await readPrivateFile(root, stateName)).equals(document(state)));
        };
        const save = async (phase, fields = {}) => {
          await check();
          const next = {
            ...(state ?? {
              version: 1,
              kind: "platform-healthy-forward-rollout-state",
              operationId,
              operationSha256,
              predecessorOperationId,
              predecessorIndexSha256,
            }),
            ...fields,
            phase,
            sequence: (state?.sequence ?? 0) + 1,
          };
          await writePrivateFile(root, stateName, document(next), { replace: Boolean(state) });
          state = next;
        };
        const verifySourceStopped = async () => {
          await check();
          await adapters.verifySourceStopped();
          await check();
        };
        const backup = async () => {
          const capability = Object.freeze({});
          let active = true;
          const holder = {
            context: Object.freeze({
              operation: Object.freeze(operation),
              verify: async () => {
                ensure(active && state.phase === "source-stopped");
                // Worker commands revalidate private authority here. A separate
                // stopped-source observation fences snapshot/restore boundaries.
                await check();
              },
            }),
          };
          backupCapabilities.set(capability, holder);
          try {
            const proofSha256 = await adapters.verifyBackup(capability);
            ensure(holder.pending && hash(proofSha256));
            return proofSha256;
          } finally {
            backupCapabilities.delete(capability);
            try {
              await holder.pending;
            } finally {
              active = false;
            }
          }
        };
        try {
          await save("admitted");
          await save("source-stop-entered");
          await adapters.preflight();
          await check();
          workloadMutationAttempted = true;
          await adapters.stopSource();
          await verifySourceStopped();
          await save("source-stopped");
          const backupProofSha256 = await backup();
          await verifySourceStopped();
          await save("backup-verified", { backupProofSha256 });
          await save("api-entered");
          const api = await adapters.activateApi();
          ensure(hash(api) && api !== operation.postgresId);
          await save("api-started", { api });
          await save("edge-entered");
          const edge = await adapters.activateEdge(api);
          ensure(hash(edge) && edge !== api && edge !== operation.postgresId);
          await save("edge-started", { edge });
          const expected = { api, edge, postgres: operation.postgresId };
          const result = plain(await adapters.verifyHealth(expected));
          ensure(canonical(result) === canonical(expected));
          await save("healthy", { postgres: expected.postgres });
          await check();
          const next = document({
            version: 1,
            kind: "platform-healthy-forward-rollout-index",
            operationId,
            predecessorIndexSha256,
            stateSha256: digest(document(state)),
          });
          // The predecessor bytes are already durable in the private archive.
          // Atomically replace the active pointer while holding the shared lock.
          await writePrivateFile(root, indexName, next, { replace: true });
          ensure((await readPrivateFile(root, indexName)).equals(next));
          return Object.freeze(result);
        } catch (cause) {
          // After a spawn attempt, keep the lock and exact last durable phase.
          // A separate reviewed recovery must determine the live state.
          if (!workloadMutationAttempted) throw cause;
          const error = new Error("Protected application rollout requires recovery.");
          error.durabilityUncertain = true;
          throw carryHostFailure(cause, error);
        }
      }),
    ),
  );
}
