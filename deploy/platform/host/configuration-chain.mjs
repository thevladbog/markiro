import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { canonical, digest, ensure, hash, keys, plain } from "../backup/schemas.mjs";
import { readProtectedEnv } from "../preflight.mjs";
import { validateUpgradeAuthorization, validateUpgradeDispatch } from "../upgrade-dispatch.mjs";
import { assertPrivateRootSync, readPrivateFile } from "./files.mjs";
import { validateDadataDelta } from "./dadata-policy.mjs";
import { validateConfigurationPlan } from "./configuration-plan.mjs";

const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value);
const same = (before, after) => ensure(canonical(before) === canonical(after));
const encode = (value) => Buffer.from(`${JSON.stringify(value)}\n`);

function api(value) {
  keys(value, ["id", "imageId", "recipeSha256"]);
  ensure(
    hash(value.id) &&
      typeof value.imageId === "string" &&
      /^sha256:[a-f0-9]{64}$/u.test(value.imageId) &&
      hash(value.recipeSha256),
  );
}
function runtime(value, host) {
  keys(value, ["path", "sha256"]);
  ensure(
    typeof value.path === "string" &&
      isAbsolute(value.path) &&
      normalize(value.path) === value.path &&
      value.path.startsWith(`${host}/`) &&
      hash(value.sha256),
  );
}
function descriptor(value, host, accepted = false) {
  keys(value, accepted ? ["acceptedOperationId", "api", "runtime"] : ["api", "runtime"]);
  if (accepted) ensure(uuid(value.acceptedOperationId));
  api(value.api);
  runtime(value.runtime, host);
}
function previous(value) {
  ensure(
    (value.previousOperationId === null && value.previousReceiptSha256 === null) ||
      (uuid(value.previousOperationId) && hash(value.previousReceiptSha256)),
  );
}
function receipt(value, host) {
  keys(value, [
    "version",
    "kind",
    "operationId",
    "acceptedOperationId",
    "planSha256",
    "previousOperationId",
    "previousReceiptSha256",
    "status",
    "before",
    "after",
    "dispatch",
    "authorization",
  ]);
  ensure(
    value.version === 1 &&
      value.kind === "platform-configuration-successor" &&
      uuid(value.operationId) &&
      uuid(value.acceptedOperationId) &&
      value.operationId !== value.acceptedOperationId &&
      hash(value.planSha256) &&
      ["healthy", "returned-old"].includes(value.status),
  );
  previous(value);
  descriptor(value.before, host);
  descriptor(value.after, host);
  ensure(
    value.before.api.id !== value.after.api.id &&
      value.before.api.imageId === value.after.api.imageId,
  );
  validateUpgradeDispatch(value.dispatch);
  validateUpgradeAuthorization(value.authorization);
  return value;
}

function refusal() {
  const error = new Error("Protected configuration successor rejected.");
  error.code = "ERR_HOST_CONFIGURATION_CHAIN";
  return error;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// Callers must hold the established host lock when deriving authority for a
// mutation. The resolver only reads immutable evidence and never issues one.
export async function resolveConfigurationRuntime(input) {
  try {
    const rootProperty = Object.getOwnPropertyDescriptor(input, "root");
    const baselineProperty = Object.getOwnPropertyDescriptor(input, "baseline");
    ensure(
      rootProperty &&
        baselineProperty &&
        Object.hasOwn(rootProperty, "value") &&
        Object.hasOwn(baselineProperty, "value"),
    );
    const root = rootProperty.value,
      baseline = baselineProperty.value;
    assertPrivateRootSync(root);
    if (await exists(join(root, "config-pending.json"))) throw refusal();
    if (!(await exists(join(root, "config-index.json")))) return baseline;
    const host = dirname(root);
    const initial = plain(baseline);
    descriptor(initial, host, true);
    const retained = new Map();
    const read = async (path) => {
      const bytes = await readPrivateFile(host, path);
      const sha256 = digest(bytes);
      if (retained.has(path)) ensure(retained.get(path) === sha256);
      else retained.set(path, sha256);
      return bytes;
    };
    const document = async (path, expectedSha256) => {
      const bytes = await read(path);
      if (expectedSha256 !== undefined) ensure(digest(bytes) === expectedSha256);
      const value = JSON.parse(bytes);
      ensure(encode(value).equals(bytes));
      return value;
    };
    const environment = async (value) => {
      runtime(value, host);
      const path = relative(host, value.path);
      ensure(digest(await read(path)) === value.sha256);
      const env = await readProtectedEnv(value.path);
      await read(path);
      return env;
    };
    const index = await document(`${relative(host, root)}/config-index.json`);
    keys(index, ["version", "kind", "head"]);
    ensure(index.version === 1 && index.kind === "platform-configuration-index");
    keys(index.head, ["operationId", "receiptSha256"]);
    ensure(uuid(index.head.operationId) && hash(index.head.receiptSha256));
    const history = [],
      seen = new Set(),
      dispatches = new Set();
    let pointer = index.head;
    while (pointer !== null) {
      ensure(history.length < 32 && !seen.has(pointer.operationId));
      seen.add(pointer.operationId);
      const directory = `${relative(host, root)}/configuration-operations/${pointer.operationId}`;
      const value = receipt(
        await document(`${directory}/receipt.json`, pointer.receiptSha256),
        host,
      );
      ensure(
        value.operationId === pointer.operationId &&
          value.acceptedOperationId === initial.acceptedOperationId &&
          !dispatches.has(value.dispatch.runId),
      );
      dispatches.add(value.dispatch.runId);
      const plan = validateConfigurationPlan(
        await document(`${directory}/operation.json`, value.planSha256),
      );
      ensure(
        [...Object.values(plan.containers), ...plan.workers].every(
          (container) => container.id !== value.after.api.id,
        ),
      );
      same(plan.before, { acceptedOperationId: value.acceptedOperationId, ...value.before });
      ensure(
        plan.operationId === value.operationId &&
          plan.acceptedOperationId === value.acceptedOperationId &&
          plan.executorSha === value.dispatch.toolingSha &&
          plan.previousOperationId === value.previousOperationId &&
          plan.previousReceiptSha256 === value.previousReceiptSha256,
      );
      for (const guard of plan.guards) ensure(digest(await read(guard.path)) === guard.sha256);
      const before = await environment(value.before.runtime);
      const candidate = await environment(plan.runtime);
      validateDadataDelta(before, candidate);
      same(value.after.runtime, value.status === "healthy" ? plan.runtime : value.before.runtime);
      // Even a returned-old receipt must bind the retained old bytes; the
      // attempted candidate is checked independently above.
      await environment(value.after.runtime);
      history.push(value);
      pointer =
        value.previousOperationId === null
          ? null
          : { operationId: value.previousOperationId, receiptSha256: value.previousReceiptSha256 };
    }
    let current = initial;
    const identities = new Set([current.api.id]);
    for (const value of history.reverse()) {
      same(value.before, { api: current.api, runtime: current.runtime });
      ensure(!identities.has(value.after.api.id));
      identities.add(value.after.api.id);
      current = {
        acceptedOperationId: value.acceptedOperationId,
        api: value.after.api,
        runtime: value.after.runtime,
      };
    }
    for (const [path, sha256] of retained)
      ensure(digest(await readPrivateFile(host, path)) === sha256);
    ensure(!(await exists(join(root, "config-pending.json"))));
    return current;
  } catch {
    throw refusal();
  }
}
