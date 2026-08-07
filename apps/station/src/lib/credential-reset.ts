import type { StationConfig } from "./config.js";

export type RunConfigTransition = <T>(
  transition: () => Promise<T>,
  publish: (value: T) => void,
) => Promise<T>;

interface CredentialResetDependencies {
  clearCredential: () => Promise<void>;
  readConfig: () => Promise<StationConfig>;
  runTransition: RunConfigTransition;
  publishConfig?: (config: StationConfig) => void;
}

/**
 * Hard reset boundary shared by the UI handler and direct/programmatic calls.
 * A keyed config without a durable device ID owns an unproven legacy queue;
 * it must never be cleared into unrestricted pairing.
 */
export async function resetCredentialForPairing(
  config: StationConfig,
  {
    clearCredential,
    readConfig,
    runTransition,
    publishConfig = () => {},
  }: CredentialResetDependencies,
): Promise<StationConfig> {
  if (config.apiKey && !config.deviceId) {
    throw new Error("legacy station identity is not durable");
  }
  return runTransition(async () => {
    await clearCredential();
    const cleared = await readConfig();
    if (
      cleared.machineId !== config.machineId ||
      cleared.deviceId !== config.deviceId ||
      cleared.serverUrl !== config.serverUrl ||
      cleared.apiKey !== undefined
    ) {
      throw new Error("credential reset contract violation");
    }
    return cleared;
  }, publishConfig);
}
