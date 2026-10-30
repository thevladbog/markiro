import { canonical, ensure, keys, plain } from "./schemas.mjs";
import { withHostState } from "../host/state.mjs";
import { resolveBoundConfigurationRuntime } from "../host/configuration-source.mjs";
import { withBackupConfigurationCapability } from "./configuration-capability.mjs";
export { assertCurrentBackupConfiguration } from "./configuration-capability.mjs";

function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Current normal-backup source; historical worker provenance is never relabeled. */
export async function withCurrentConfigurationSource(input, action) {
  const selection = plain(input);
  keys(selection, ["root", "baseline", "expectedHead"]);
  ensure(typeof action === "function");
  return withHostState(selection.root, (store) =>
    store.guardPersistence(async (capability) => {
      const current = freeze(await resolveBoundConfigurationRuntime(selection)),
        identity = canonical(current);
      const verify = async () =>
        ensure(canonical(await resolveBoundConfigurationRuntime(selection)) === identity);
      return withBackupConfigurationCapability(
        capability,
        { root: selection.root, current, verify },
        action,
      );
    }),
  );
}
