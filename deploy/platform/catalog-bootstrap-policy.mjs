import {
  validateConfigurationBaseline,
  validateConfigurationRuntime,
} from "./host/configuration-plan.mjs";
import { canonical, ensure, keys } from "./backup/schemas.mjs";
import { COMPATIBLE_PRODUCT_SHA } from "../../tools/release-catalog/bootstrap-artifact.mjs";
const sha = (v) => typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const id = (v) => typeof v === "string" && /^[1-9][0-9]{0,19}$/u.test(v);
const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(v);
const path = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-][A-Za-z0-9._/-]*$/u.test(v) &&
  v.split("/").every((p) => p && p !== "." && p !== "..") &&
  !v.endsWith("github-token");
export function validateReadBootstrapOperation(o) {
  keys(o, [
    "schema",
    "kind",
    "operationId",
    "catalogOperationId",
    "executorSha",
    "executorCi",
    "productSourceSha",
    "artifact",
    "inputFileSha256",
    "bootstrapModuleSha256",
    "runtimeScriptSha256",
    "binding",
    "acceptedOperationId",
    "guards",
    "containers",
    "networkId",
    "egressNetworkId",
    "schemaProof",
    "postgresCaSha256",
    ...(o.schema === 2 ? ["configuration"] : []),
  ]);
  ensure(
    [1, 2].includes(o.schema) &&
      o.kind === "catalog-read-bootstrap" &&
      uuid(o.operationId) &&
      uuid(o.catalogOperationId) &&
      uuid(o.acceptedOperationId),
  );
  ensure(
    typeof o.executorSha === "string" &&
      /^[a-f0-9]{40}$/u.test(o.executorSha) &&
      o.productSourceSha === COMPATIBLE_PRODUCT_SHA,
  );
  keys(o.executorCi, ["runId", "runAttempt"]);
  ensure(id(o.executorCi.runId) && o.executorCi.runAttempt === "1");
  keys(o.artifact, ["id", "zipSha256"]);
  ensure(id(o.artifact.id) && sha(o.artifact.zipSha256));
  ensure(
    [
      o.inputFileSha256,
      o.bootstrapModuleSha256,
      o.runtimeScriptSha256,
      o.networkId,
      o.egressNetworkId,
    ].every(sha),
  );
  ensure(sha(o.postgresCaSha256) && o.networkId !== o.egressNetworkId);
  keys(o.binding, ["operationId", "epoch", "evidenceSha256", "identity", "targetVersion"]);
  keys(o.binding.identity, ["product", "channel"]);
  ensure(
    o.binding.operationId === o.catalogOperationId &&
      uuid(o.binding.epoch) &&
      sha(o.binding.evidenceSha256) &&
      ["standalone", "handheld"].includes(o.binding.identity.product) &&
      o.binding.identity.channel === "stable" &&
      /^\d+\.\d+\.\d+$/u.test(o.binding.targetVersion),
  );
  ensure(Array.isArray(o.guards) && o.guards.length <= 1000);
  for (const guard of o.guards) {
    keys(guard, ["path", "sha256"]);
    ensure(path(guard.path) && sha(guard.sha256));
  }
  const names = new Set(o.guards.map((g) => g.path));
  ensure(names.size === o.guards.length);
  ensure(
    [
      "state/state.json",
      "state/backup-runtime.json",
      "state/upgrade-index.json",
      `state/forward-recovery-operations/${o.acceptedOperationId}/state.json`,
    ].every((name) => names.has(name)),
  );
  ensure([...names].some((name) => /^state\/candidates\/[a-f0-9-]{36}\/runtime.env$/u.test(name)));
  keys(o.containers, ["api", "edge", "postgres"]);
  for (const c of Object.values(o.containers)) {
    keys(c, ["id", "imageId", "recipeSha256"]);
    ensure(
      sha(c.id) &&
        typeof c.imageId === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(c.imageId) &&
        sha(c.recipeSha256),
    );
  }
  ensure(new Set(Object.values(o.containers).map((c) => c.id)).size === 3);
  keys(o.schemaProof, ["systemId", "schemaSha256", "migrationSha256", "migrationCount"]);
  ensure(
    id(o.schemaProof.systemId) &&
      id(o.schemaProof.migrationCount) &&
      sha(o.schemaProof.schemaSha256) &&
      sha(o.schemaProof.migrationSha256),
  );
  if (o.schema === 2) {
    canonical(o.configuration);
    const c = o.configuration;
    keys(c, ["baseline", "head", "runtime"]);
    validateConfigurationBaseline(c.baseline);
    validateConfigurationRuntime(c.runtime);
    ensure(c.baseline.acceptedOperationId === o.acceptedOperationId);
    keys(c.head, ["operationId", "receiptSha256"]);
    ensure(
      uuid(c.head.operationId) &&
        sha(c.head.receiptSha256) &&
        c.head.operationId !== o.acceptedOperationId,
    );
    const marker = c.baseline.runtime.path.indexOf("/state/");
    ensure(
      marker > 0 &&
        c.runtime.path.startsWith(c.baseline.runtime.path.slice(0, marker) + "/state/") &&
        c.runtime.path.endsWith("/runtime.env"),
    );
    ensure(names.has("state/config-index.json"));
    ensure(
      o.guards.some(
        (g) =>
          g.path === `state/configuration-operations/${c.head.operationId}/receipt.json` &&
          g.sha256 === c.head.receiptSha256,
      ),
    );
  }
  return o;
}
export function workerEnvironment(entries) {
  ensure(Array.isArray(entries));
  const values = new Map();
  for (const entry of entries) {
    ensure(typeof entry === "string" && !/[\r\n\0]/u.test(entry));
    const offset = entry.indexOf("=");
    ensure(offset > 0);
    const key = entry.slice(0, offset);
    ensure(!values.has(key));
    values.set(key, entry.slice(offset + 1));
  }
  ensure(
    values.get("SERVER_PROFILE") === "platform-only" &&
      values.get("RELEASE_CATALOG_WRITERS_ENABLED") === "false" &&
      values.get("DATABASE_URL"),
  );
  return entries.filter((entry) =>
    /^(?:DATABASE_URL|SERVER_PROFILE|RELEASE_CATALOG_(?!PUBLISHERS_JSON=)[A-Z0-9_]+)=/u.test(entry),
  );
}
export function sameReadBootstrap(a, b) {
  ensure(canonical(a) === canonical(b));
}

export function postgresCaMount(api) {
  const environment = Object.fromEntries(
    api.Config.Env.map((entry) => {
      const index = entry.indexOf("=");
      return [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  const url = new URL(environment.DATABASE_URL);
  ensure(
    url.searchParams.get("sslmode") === "verify-full" &&
      url.searchParams.get("sslrootcert") === "/run/markiro-postgres/ca.crt",
  );
  const mounts = api.Mounts.filter((m) => m.Destination === "/run/markiro-postgres/ca.crt");
  ensure(mounts.length === 1);
  const ca = mounts[0];
  ensure(
    ca.Type === "bind" &&
      ca.RW === false &&
      typeof ca.Source === "string" &&
      ca.Source.startsWith("/opt/markiro-platform/") &&
      path(ca.Source.slice("/opt/markiro-platform/".length)),
  );
  return ca;
}
export function readBootstrapWorkerArguments({ operation, root, api }) {
  const ca = postgresCaMount(api);
  const mounts = [
    [
      `${root}/catalog-bootstrap.js`,
      "/app/dist/modules/release-catalog/catalog-bootstrap.js",
      true,
    ],
    [`${root}/bootstrap-runtime.mjs`, "/app/bootstrap-runtime.mjs", true],
    [`${root}/input.json`, "/bootstrap/input.json", true],
    [`${root}/rpc`, "/bootstrap/rpc", false],
    [ca.Source, ca.Destination, true],
    ...["cache", "journal"].map((name) => [
      `/opt/markiro-platform/release-catalog/${name}`,
      `/opt/markiro-platform/release-catalog/${name}`,
      false,
    ]),
  ];
  return [
    "create",
    "--name",
    `markiro-catalog-bootstrap-${operation.operationId}`,
    "--label",
    `markiro.catalog-bootstrap=${operation.operationId}`,
    "--user",
    "1000:1000",
    "--network",
    operation.egressNetworkId,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "128",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--workdir",
    "/app",
    "--env-file",
    `${root}/worker.env`,
    ...mounts.flatMap(([source, target, readonly]) => [
      "--mount",
      `type=bind,source=${source},target=${target}${readonly ? ",readonly" : ""}`,
    ]),
    "--entrypoint",
    "/usr/local/bin/node",
    operation.containers.api.imageId,
    "/app/bootstrap-runtime.mjs",
  ];
}

export function validateBootstrapCaFile(info) {
  const mode = info.mode & 0o7777;
  ensure(
    [0, 1000].includes(info.uid) &&
      [0, 1000].includes(info.gid) &&
      (mode & 0o7022) === 0 &&
      info.size > 0 &&
      info.size <= 65536,
  );
  const read = info.uid === 1000 ? mode & 0o400 : info.gid === 1000 ? mode & 0o040 : mode & 0o004;
  ensure(read !== 0);
  return { owner: info.uid, mode };
}

function sameNetworkIds(container, expected) {
  const actual = Object.values(container.NetworkSettings.Networks).map(
    (network) => network.NetworkID,
  );
  ensure(actual.length === expected.length && new Set(actual).size === actual.length);
  sameReadBootstrap([...actual].sort(), [...expected].sort());
}
export function validateReadBootstrapNetworks(operation, { api, postgres, networks, worker }) {
  ensure(
    sha(operation.networkId) &&
      sha(operation.egressNetworkId) &&
      operation.networkId !== operation.egressNetworkId,
  );
  sameNetworkIds(api, [operation.networkId, operation.egressNetworkId]);
  sameNetworkIds(postgres, [operation.networkId]);
  if (worker) sameNetworkIds(worker, [operation.networkId, operation.egressNetworkId]);
  ensure(Array.isArray(networks) && networks.length === 2);
  for (const [name, id, internal] of [
    ["database", operation.networkId, true],
    ["default", operation.egressNetworkId, false],
  ]) {
    const matches = networks.filter((network) => network.Id === id);
    ensure(matches.length === 1);
    const n = matches[0];
    ensure(
      n.Name === `markiro-platform_${name}` &&
        n.Driver === "bridge" &&
        n.Scope === "local" &&
        n.Internal === internal &&
        n.Attachable === false &&
        n.Ingress === false &&
        n.Labels?.["com.docker.compose.project"] === "markiro-platform" &&
        n.Labels?.["com.docker.compose.network"] === name,
    );
  }
}
export function readBootstrapWorkerDatabaseArguments(operation, workerId) {
  ensure(
    sha(operation.networkId) &&
      sha(operation.egressNetworkId) &&
      operation.networkId !== operation.egressNetworkId &&
      sha(workerId),
  );
  return ["network", "connect", operation.networkId, workerId];
}
