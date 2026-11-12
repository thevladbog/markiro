import { mapInventory } from "../backup/inventory.mjs";
import {
  canonical,
  digest,
  ensure,
  fence,
  hash,
  keys,
  plain,
  timestamp,
} from "../backup/schemas.mjs";
import { assertExclusiveCatalogMounts, catalogMountBindings } from "../catalog-config.mjs";
import { readVerifiedBackup } from "./backup-gate.mjs";
import { validateConfigurationContainer } from "./configuration-plan.mjs";
import { containerRecipe } from "./container-recipe.mjs";
import { carryHostFailure } from "./failure-diagnostic.mjs";
import { validateObservationPolicy } from "./observe.mjs";
import { verifyRetainedCatalogWorkers } from "./retained-catalog-workers.mjs";

/** Verify evidence from the current held operation. The coordinator owns backup production and the fence observer. */
export async function verifyHealthyForwardBackup(input, { observeFence }) {
  try {
    const value = plain(input);
    keys(value, [
      "root",
      "identity",
      "backup",
      "restoreEvidence",
      "migrationJournal",
      "roleMapping",
    ]);
    const { root, identity, backup, restoreEvidence, migrationJournal, roleMapping } = value;
    ensure(typeof observeFence === "function");
    keys(migrationJournal, ["count", "sha256"]);
    ensure(
      typeof migrationJournal.count === "string" &&
        /^[1-9][0-9]*$/u.test(migrationJournal.count) &&
        hash(migrationJournal.sha256),
    );

    const { document, evidence, backupProof } = await readVerifiedBackup({
      root,
      identity,
      backup,
      restoreEvidence,
    });
    ensure(document.provenance === "live-source" && document.catalogBackup !== undefined);
    ensure(canonical(document.inventory.migrationJournal) === canonical(migrationJournal));
    ensure(evidence.roleMappingSha256 === digest(roleMapping));
    ensure(
      evidence.restoredInventorySha256 === digest(mapInventory(document.inventory, roleMapping)),
    );

    const { operationId, target } = identity;
    const boundary = "prepared-target";
    const current = fence(
      await observeFence({ operationId, target, boundary }),
      operationId,
      target,
      boundary,
    );
    for (const key of ["fenceId", "enforcementSha256", "beganAt"])
      ensure(current[key] === document.fence.after[key]);
    ensure(timestamp(current.observedAt) >= timestamp(evidence.completedAt));
    return Object.freeze({ ...backupProof, target: Object.freeze(backupProof.target) });
  } catch (cause) {
    const error = new Error("Healthy forward backup admission refused.");
    error.code = "ERR_HEALTHY_FORWARD_BACKUP";
    throw carryHostFailure(cause, error);
  }
}

/** The caller supplies all containers from the same held, unfiltered Docker inventory. */
export async function verifyHealthyForwardCatalogCustody(input) {
  try {
    keys(input, [
      "hostRoot",
      "acceptedOperationId",
      "api",
      "workers",
      "inventory",
      "catalogEnvironment",
      "guards",
    ]);
    const { guards, ...metadata } = input;
    const { hostRoot, acceptedOperationId, api, workers, inventory, catalogEnvironment } =
      plain(metadata);
    validateConfigurationContainer(api);
    ensure(guards instanceof Map && Array.isArray(inventory) && Array.isArray(workers));
    const ids = inventory.map((row) => row.Id);
    ensure(ids.every(hash) && new Set(ids).size === ids.length);
    ensure(
      inventory.every(
        (row) =>
          Array.isArray(row.Mounts) &&
          row.Mounts.every((mount) => typeof mount.Source === "string"),
      ),
    );
    ensure(workers.every((worker) => worker.id !== api.id));
    const currentApi = inventory.find((row) => row.Id === api.id);
    ensure(
      currentApi &&
        currentApi.Image === api.imageId &&
        containerRecipe(currentApi) === api.recipeSha256 &&
        currentApi.Config.Labels?.["com.docker.compose.project"] === "markiro-platform" &&
        currentApi.Config.Labels?.["com.docker.compose.service"] === "api",
    );
    keys(catalogEnvironment, ["RELEASE_CATALOG_CACHE_DIR", "RELEASE_CATALOG_JOURNAL_DIR"]);
    const mounts = Object.entries(catalogMountBindings(catalogEnvironment, "api"));
    ensure(mounts.length === 2);
    for (const [destination, source] of mounts) {
      const matches = currentApi.Mounts.filter((mount) => mount.Destination === destination);
      ensure(
        matches.length === 1 &&
          matches[0].Source === source &&
          matches[0].Type === "bind" &&
          matches[0].RW === true,
      );
    }
    const retained = await verifyRetainedCatalogWorkers({
      hostRoot,
      acceptedOperationId,
      expected: workers,
      inventory,
      guards: new Map(guards),
    });
    const retainedIds = new Set(workers.map(({ id }) => id));
    assertExclusiveCatalogMounts(
      inventory.filter((row) => !retainedIds.has(row.Id)),
      api.id,
    );
    return Object.freeze(retained.map((record) => Object.freeze(record)));
  } catch (cause) {
    const error = new Error("Healthy forward catalog custody refused.");
    error.code = "ERR_HEALTHY_FORWARD_CATALOG_CUSTODY";
    throw carryHostFailure(cause, error);
  }
}

/** Keep both private stores exclusive while there are no temporary backup workers. */
export async function observeHealthyForwardCatalogCustody(input, command) {
  const { postgres, observationPolicy, ...catalog } = input;
  const policy = validateObservationPolicy(observationPolicy);
  validateConfigurationContainer(postgres);
  ensure(typeof command === "function");
  const ids = String((await command(["container", "ls", "--all", "--quiet", "--no-trunc"])).stdout)
    .trim()
    .split(/\s+/u);
  ensure(
    ids.length >= 3 && ids.length <= 32 && ids.every(hash) && new Set(ids).size === ids.length,
  );
  const inventory = JSON.parse(String((await command(["container", "inspect", ...ids])).stdout));
  ensure(
    Array.isArray(inventory) &&
      inventory.length === ids.length &&
      new Set(inventory.map(({ Id }) => Id)).size === ids.length &&
      inventory.every(({ Id }) => ids.includes(Id)),
  );
  const database = inventory.find(({ Id }) => Id === postgres.id);
  ensure(
    database &&
      database.Image === postgres.imageId &&
      postgres.imageId === policy.postgresImageId &&
      containerRecipe(database) === postgres.recipeSha256 &&
      Object.keys(database.HostConfig.PortBindings ?? {}).length === 0 &&
      database.State?.Running === true &&
      database.State.Health?.Status === "healthy" &&
      database.Mounts.some(
        (mount) =>
          mount.Type === "volume" &&
          mount.Name === policy.volume.name &&
          mount.Source === policy.volume.mountpoint &&
          mount.Destination === "/var/lib/postgresql/data",
      ),
  );
  const mounted = (source, path) =>
    source === path ||
    path.startsWith(`${source.replace(/\/$/u, "")}/`) ||
    source.startsWith(`${path}/`);
  const workers = new Set(catalog.workers.map(({ id }) => id));
  for (const row of inventory) {
    if (row.Id === database.Id) continue;
    ensure(
      Array.isArray(row.Mounts) &&
        row.Mounts.every(
          (mount) =>
            mount.Name !== policy.volume.name &&
            typeof mount.Source === "string" &&
            !mounted(mount.Source, policy.volume.mountpoint),
        ),
    );
    const network = Object.values(row.NetworkSettings?.Networks ?? {}).some(
      ({ NetworkID }) => NetworkID === policy.networks.database.id,
    );
    if (network) ensure(row.Id === catalog.api.id || workers.has(row.Id));
  }
  return verifyHealthyForwardCatalogCustody({ ...catalog, inventory });
}
