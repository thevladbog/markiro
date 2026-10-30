import { canonical, digest, ensure, keys } from "../backup/schemas.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { readPrivateFile } from "./files.mjs";
import { containerRecipe } from "./container-recipe.mjs";

const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
/** Exact immutable custody for previously accepted one-shot workers, never another API. */
export async function verifyRetainedCatalogWorkers({
  hostRoot,
  acceptedOperationId,
  expected,
  inventory,
  guards,
}) {
  try {
    canonical(expected);
    canonical(inventory);
    ensure(
      uuid(acceptedOperationId) &&
        Array.isArray(expected) &&
        expected.length <= 29 &&
        Array.isArray(inventory),
    );
    ensure(new Set(expected.map((w) => w.id)).size === expected.length);
    if (guards !== undefined) ensure(guards instanceof Map);
    const result = [];
    for (const descriptor of expected) {
      keys(descriptor, ["id", "imageId", "recipeSha256"]);
      const rows = inventory.filter((w) => w.Id === descriptor.id);
      ensure(rows.length === 1);
      const worker = rows[0],
        operationId = worker.Config?.Labels?.["markiro.catalog-bootstrap"];
      ensure(uuid(operationId) && worker.Name === `/markiro-catalog-bootstrap-${operationId}`);
      ensure(
        worker.Image === descriptor.imageId && containerRecipe(worker) === descriptor.recipeSha256,
      );
      ensure(
        worker.Config.User === "1000:1000" &&
          worker.HostConfig.ReadonlyRootfs === true &&
          worker.HostConfig.Privileged === false &&
          canonical(worker.HostConfig.CapDrop) === canonical(["ALL"]),
      );
      const state = worker.State;
      ensure(
        state?.Status === "exited" &&
          state.Running === false &&
          state.Pid === 0 &&
          state.ExitCode === 0 &&
          ["OOMKilled", "Paused", "Restarting", "Dead"].every((k) => state[k] === false),
      );
      const read = async (name) => {
        const path = `catalog-bootstrap-operations/${operationId}/${name}`;
        const bytes = await readPrivateFile(hostRoot, path),
          sha256 = digest(bytes);
        if (guards !== undefined) ensure(guards.get(path) === sha256);
        const value = JSON.parse(bytes);
        ensure(Buffer.from(JSON.stringify(value) + "\n").equals(bytes));
        result.push({ path, sha256 });
        return { value, sha256 };
      };
      const operation = await read("operation.json"),
        completed = (await read("completed.json")).value,
        created = (await read("worker-created.json")).value,
        terminal = (await read("worker-terminal.json")).value;
      ensure(
        [1, 2].includes(operation.value.schema) &&
          operation.value.kind === "catalog-read-bootstrap" &&
          operation.value.operationId === operationId &&
          operation.value.acceptedOperationId === acceptedOperationId &&
          /^[a-f0-9]{40}$/u.test(operation.value.executorSha) &&
          operation.value.containers?.api?.imageId === worker.Image,
      );
      keys(completed, [
        "schema",
        "operationId",
        "planSha256",
        "dispatch",
        "authorization",
        "phase",
        "observedAt",
      ]);
      validateUpgradeDispatch(completed.dispatch);
      validateUpgradeAuthorization(completed.authorization);
      ensure(
        completed.schema === 1 &&
          completed.operationId === operationId &&
          completed.phase === "completed" &&
          completed.planSha256 === operation.sha256 &&
          completed.dispatch.toolingSha === operation.value.executorSha &&
          new Date(completed.observedAt).toISOString() === completed.observedAt,
      );
      keys(created, ["id", "operationId"]);
      ensure(created.id === worker.Id && created.operationId === operationId);
      keys(terminal, ["id", "exitCode", "oomKilled", "result"]);
      ensure(
        terminal.id === worker.Id &&
          terminal.exitCode === 0 &&
          terminal.oomKilled === false &&
          terminal.result?.revision === "1" &&
          terminal.result.readable === true &&
          terminal.result.writersMayEnable === false,
      );
    }
    return result;
  } catch {
    const error = new Error("Retained catalog worker custody rejected.");
    error.code = "ERR_RETAINED_CATALOG_WORKER";
    throw error;
  }
}
