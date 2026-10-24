import { catalogComposeFiles } from "../catalog-config.mjs";
import { canonical, ensure, keys, plain } from "../backup/schemas.mjs";
import { readProtectedEnv, validateConfig } from "../preflight.mjs";
import { fingerprintHostConfiguration, hostChildEnvironment } from "./config.mjs";
import { validatePreparedTarget } from "./prepared-target.mjs";

export const freezeHostValue = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeHostValue(child);
    Object.freeze(value);
  }
  return value;
};

// Shared authorities for ordinary and recovery coordinators. Context and owner
// remain coordinator-specific; this helper never acquires or mutates a journal.
export function preparedHostBoundary({
  root,
  identity,
  configuration,
  dockerConfig,
  preparedTarget,
  preparedPolicy,
  adapters,
  context,
  onOwnership = () => {},
  onEnvironment = () => {},
}) {
  let environment, recheckPreparedFreshness;
  const project = "markiro-platform";
  const checkActivationDeadline = () => {
    if (preparedTarget.version !== 2) return;
    const value = preparedTarget.observations.egress.value,
      now = Date.now();
    ensure(Date.parse(value.expiresAt) > now && Date.parse(value.sourceHold.expiresAt) > now);
  };
  const checkConfiguration = async () => {
    const fingerprint = await fingerprintHostConfiguration({ root, ...configuration });
    ensure(fingerprint.configurationSha256 === identity.configurationSha256);
    const runtime = await readProtectedEnv(configuration.runtimeSnapshot.path);
    validateConfig(runtime, identity.admission.manifest);
    const interpolation = {
      ...configuration.runtimeSnapshot.interpolation,
      MARKIRO_PLATFORM_MIGRATION_ENV_FILE: configuration.migrationSnapshot.path,
    };
    for (const [key, value] of Object.entries(interpolation)) {
      const expected =
        key === "MARKIRO_PLATFORM_ENV_FILE"
          ? configuration.runtimeSnapshot.path
          : key === "MARKIRO_PLATFORM_MIGRATION_ENV_FILE"
            ? configuration.migrationSnapshot.path
            : runtime[key];
      ensure(value === expected);
    }
    environment = freezeHostValue(hostChildEnvironment({ interpolation, dockerConfig }));
    onEnvironment(environment, catalogComposeFiles(runtime));
  };
  const observeTarget = async (name) => {
    onOwnership(false);
    const observed = plain(await adapters.inspectTarget(context(name)));
    keys(observed, ["target", "project", "serverProfile", "uiProfile", "os", "architecture"]);
    ensure(
      canonical(observed.target) === canonical(identity.target) &&
        observed.project === project &&
        observed.serverProfile === "platform-only" &&
        observed.uiProfile === "platform-only" &&
        observed.os === "linux" &&
        observed.architecture === "amd64",
    );
    onOwnership(true);
  };
  const boundary = async (name) => {
    await checkConfiguration();
    await observeTarget(name);
    const verified = await validatePreparedTarget(preparedTarget, {
      root,
      identity,
      configuration,
      ...preparedPolicy,
      writerFence: {
        ...adapters.writerFence,
        observe: (request) =>
          adapters.writerFence.observe({
            ...context(name),
            ...request,
            transitionBoundary: name,
          }),
      },
      workload: adapters.workload,
    });
    recheckPreparedFreshness = verified.recheckFreshness;
    // Observers may take time or touch external state: reject changed bytes
    // again before the protected transition or command.
    await checkConfiguration();
    checkActivationDeadline();
    return verified.backupProof;
  };
  const checkPreparedFreshness = () => {
    ensure(typeof recheckPreparedFreshness === "function");
    recheckPreparedFreshness();
  };
  return {
    boundary,
    checkActivationDeadline,
    checkConfiguration,
    checkPreparedFreshness,
    observeTarget,
  };
}
