import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { ensure } from "./schemas.mjs";
import { assertPrivateRootSync } from "../host/files.mjs";
import { withHeldHostState } from "../host/state.mjs";

const currentSources = new WeakMap();

/**
 * Internal trusted producer boundary. A genuine held-host capability supplies
 * lock ownership, not chain verification. Only fixed installed code may supply
 * verify; public current-source selection stays in configuration-source.mjs.
 * Neither this callback nor the opaque capability can come from operation JSON.
 */
export function withBackupConfigurationCapability(capability, { root, current, verify }, action) {
  ensure(typeof verify === "function" && typeof action === "function");
  return withHeldHostState(capability, async (held) => {
    ensure(held.root === root);
    let active = true;
    const guardedVerify = async () => {
      ensure(active);
      await verify();
      ensure(active);
    };
    const context = Object.freeze({ current, verify: guardedVerify });
    currentSources.set(context, { root, verify: guardedVerify });
    try {
      await guardedVerify();
      const result = await action(context);
      await guardedVerify();
      return result;
    } finally {
      active = false;
      currentSources.delete(context);
    }
  });
}

export async function assertCurrentBackupConfiguration(root, context) {
  assertPrivateRootSync(root);
  if (context !== undefined) {
    const owned = currentSources.get(context);
    ensure(owned && owned.root === root);
    await owned.verify();
    return;
  }
  for (const name of ["config-pending.json", "config-index.json"]) {
    try {
      await lstat(join(root, name));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    ensure(false);
  }
}
