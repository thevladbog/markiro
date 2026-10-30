import { canonical, ensure, fail, hash } from "../backup/schemas.mjs";

const dadataKeys = Object.freeze(["DADATA_TOKEN", "DADATA_SECRET"]);
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const map = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Validate descriptors before reading any value, including array entries. A
// malformed caller must never execute a getter or inject its error into output.
function document(value, depth = 0) {
  ensure(depth < 30);
  if (value === null || ["string", "boolean"].includes(typeof value)) return value;
  if (typeof value === "number") {
    ensure(Number.isSafeInteger(value));
    return value;
  }
  const array = Array.isArray(value);
  ensure(array || map(value));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (array) {
    ensure(Object.getPrototypeOf(value) === Array.prototype);
    ensure(keys.length === value.length + 1);
    ensure(keys.every((key) => key === "length" || /^(0|[1-9][0-9]*)$/u.test(key)));
  }
  const entries = [];
  for (const key of keys) {
    if (array && key === "length") continue;
    const descriptor = descriptors[key];
    ensure(
      typeof key === "string" &&
        key !== "__proto__" &&
        descriptor.enumerable &&
        Object.hasOwn(descriptor, "value"),
    );
    entries.push([key, document(descriptor.value, depth + 1)]);
  }
  if (!array) return Object.fromEntries(entries);
  ensure(entries.every(([key], index) => key === String(index)));
  return entries.map(([, entry]) => entry);
}
function protectedCheck(action) {
  try {
    return action();
  } catch {
    throw fail();
  }
}
function environment(value) {
  ensure(map(value));
  for (const [key, entry] of Object.entries(value))
    ensure(
      /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) && typeof entry === "string" && !controls.test(entry),
    );
  return value;
}
function withoutDadata(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !dadataKeys.includes(key)));
}
function environmentDelta(before, after) {
  environment(before);
  environment(after);
  ensure(canonical(withoutDadata(before)) === canonical(withoutDadata(after)));
  ensure(
    typeof after.DADATA_TOKEN === "string" &&
      after.DADATA_TOKEN.length > 0 &&
      after.DADATA_TOKEN.trim() === after.DADATA_TOKEN,
  );
  if (Object.hasOwn(after, "DADATA_SECRET"))
    ensure(after.DADATA_SECRET.length > 0 && after.DADATA_SECRET.trim() === after.DADATA_SECRET);
  const changed = dadataKeys.filter(
    (key) => Object.hasOwn(before, key) !== Object.hasOwn(after, key) || before[key] !== after[key],
  );
  ensure(changed.length > 0);
  return Object.freeze(changed);
}

/** Allow one complete private environment to succeed another by DaData alone. */
export function validateDadataDelta(before, after) {
  return protectedCheck(() => environmentDelta(document(before), document(after)));
}

/** Compare complete rendered Compose documents, including every other service. */
export function assertDadataComposeDelta(before, after) {
  return protectedCheck(() => {
    const old = document(before),
      next = document(after);
    ensure(map(old) && map(next));
    ensure(map(old.services) && map(next.services));
    ensure(map(old.services.api) && map(next.services.api));
    const changed = environmentDelta(old.services.api.environment, next.services.api.environment);
    old.services.api.environment = withoutDadata(old.services.api.environment);
    next.services.api.environment = withoutDadata(next.services.api.environment);
    ensure(canonical(old) === canonical(next));
    return changed;
  });
}

function inspectEnvironment(entries) {
  ensure(Array.isArray(entries));
  const env = Object.create(null);
  for (const entry of entries) {
    ensure(typeof entry === "string");
    const separator = entry.indexOf("=");
    ensure(separator > 0);
    const key = entry.slice(0, separator);
    ensure(!Object.hasOwn(env, key));
    env[key] = entry.slice(separator + 1);
  }
  return environment(env);
}
function mounts(entries, destinationKey = "Destination") {
  ensure(Array.isArray(entries));
  const destinations = new Set();
  for (const entry of entries) {
    ensure(
      map(entry) &&
        typeof entry[destinationKey] === "string" &&
        entry[destinationKey].startsWith("/"),
    );
    ensure(!destinations.has(entry[destinationKey]));
    destinations.add(entry[destinationKey]);
  }
  return entries.sort((a, b) => a[destinationKey].localeCompare(b[destinationKey]));
}
function networks(settings) {
  ensure(map(settings) && map(settings.Networks) && Object.keys(settings.Networks).length > 0);
  delete settings.SandboxID;
  delete settings.SandboxKey;
  for (const network of Object.values(settings.Networks)) {
    ensure(map(network));
    for (const key of ["NetworkID", "Aliases", "Links", "IPAMConfig", "DriverOpts"])
      ensure(Object.hasOwn(network, key));
    ensure(typeof network.NetworkID === "string" && network.NetworkID.length > 0);
    for (const key of [
      "EndpointID",
      "IPAddress",
      "IPPrefixLen",
      "Gateway",
      "IPv6Gateway",
      "GlobalIPv6Address",
      "GlobalIPv6PrefixLen",
      "MacAddress",
      "DNSNames",
    ])
      delete network[key];
  }
  return settings;
}
function recipe(value, configHash) {
  ensure(map(value) && /^[a-f0-9]{64}$/u.test(value.Id));
  ensure(typeof value.Name === "string" && value.Name.startsWith("/"));
  ensure(/^sha256:[a-f0-9]{64}$/u.test(value.Image));
  ensure(map(value.Config) && map(value.HostConfig));
  ensure(typeof value.Config.Image === "string" && value.Config.Image.length > 0);
  ensure(map(value.Config.Labels));
  ensure(value.Config.Labels["com.docker.compose.config-hash"] === configHash);
  delete value.Config.Labels["com.docker.compose.config-hash"];
  const hostname = value.Config.Hostname;
  ensure(typeof hostname === "string" && hostname.length > 0);
  if (hostname === value.Id.slice(0, 12)) delete value.Config.Hostname;
  if (Object.hasOwn(value.HostConfig, "Mounts") && value.HostConfig.Mounts !== null)
    value.HostConfig.Mounts = mounts(value.HostConfig.Mounts, "Target");
  const env = inspectEnvironment(value.Config.Env);
  value.Config.Env = withoutDadata(env);
  return {
    env,
    value: {
      Name: value.Name,
      Image: value.Image,
      Config: value.Config,
      HostConfig: value.HostConfig,
      Mounts: mounts(value.Mounts),
      NetworkSettings: networks(value.NetworkSettings),
    },
  };
}

/** Verify the replacement API keeps the full recipe and network memberships. */
export function assertDadataContainerDelta(before, after, options) {
  return protectedCheck(() => {
    const old = document(before),
      next = document(after),
      expected = document(options);
    ensure(map(old) && map(next) && map(expected));
    ensure(
      Object.keys(expected).length === 2 &&
        hash(expected.beforeConfigHash) &&
        hash(expected.afterConfigHash),
    );
    ensure(old.Id !== next.Id);
    ensure(map(next.State) && map(next.State.Health));
    ensure(
      next.State.Status === "running" &&
        next.State.Running === true &&
        next.State.Health.Status === "healthy",
    );
    for (const key of ["OOMKilled", "Restarting", "Paused", "Dead"])
      ensure(next.State[key] === false);
    const previous = recipe(old, expected.beforeConfigHash),
      candidate = recipe(next, expected.afterConfigHash);
    const changed = environmentDelta(previous.env, candidate.env);
    ensure(canonical(previous.value) === canonical(candidate.value));
    return changed;
  });
}
