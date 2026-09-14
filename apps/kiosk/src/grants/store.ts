import type { DeviceGrant, TaskGrant, TrustedClock, VerificationKey } from "@markiro/domain";
import type { KioskConfig } from "../store/config.js";
import { abortTransaction, STORE_CONFIG, STORE_GRANTS, withTransaction } from "../store/db.js";
import {
  boxRegistryCredentialOwnerOf,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";

export interface StoredGrant {
  grant: DeviceGrant | TaskGrant;
  compact: string;
  kid: string;
  credentialGeneration: string;
}
export interface GrantState {
  configurationReceived?: boolean;
  binding: BoxRegistryCredentialOwner["binding"];
  credentialGeneration: string;
  tenantId: string | null;
  epoch: number;
  mode: "observe" | "strict";
  requestedSequence: number;
  installedSequence: number;
  keysetRevision: string;
  keys: VerificationKey[];
  retiredKids: string[];
  clock: TrustedClock | null;
  clockTrusted?: boolean;
  serverHighWaterMs?: number;
  device?: StoredGrant;
}
export interface GrantContext {
  tx: IDBTransaction;
  store: IDBObjectStore;
  config: KioskConfig | null;
  owner: BoxRegistryCredentialOwner | null;
  state: GrantState | null;
  key: string;
}
export function stateKey(owner: BoxRegistryCredentialOwner): string {
  return JSON.stringify(["state", owner.binding.serverUrl, owner.binding.kioskId]);
}
export function runChecked(tx: IDBTransaction, run: () => void): void {
  try {
    run();
  } catch (error) {
    abortTransaction(tx, error instanceof Error ? error : new Error(String(error)));
  }
}
/** All dependent requests stay in IDB event callbacks. No promises, WebCrypto or network in run. */
export async function withGrantTransaction(
  extraStores: readonly string[],
  run: (context: GrantContext) => void,
): Promise<void> {
  await withTransaction(
    [...new Set([STORE_CONFIG, STORE_GRANTS, ...extraStores])],
    "readwrite",
    (tx) => {
      const configRequest = tx.objectStore(STORE_CONFIG).get("current");
      configRequest.onsuccess = () =>
        runChecked(tx, () => {
          const config = (configRequest.result as KioskConfig | undefined) ?? null;
          const owner = config?.token ? boxRegistryCredentialOwnerOf(config) : null;
          const key = owner ? stateKey(owner) : "unpaired";
          const store = tx.objectStore(STORE_GRANTS);
          const stateRequest = store.get(key);
          stateRequest.onsuccess = () =>
            runChecked(tx, () =>
              run({
                tx,
                store,
                config,
                owner,
                key,
                state: (stateRequest.result as GrantState | undefined) ?? null,
              }),
            );
        });
    },
  );
}
export async function readGrantState(): Promise<GrantState | null> {
  let result: GrantState | null = null;
  await withGrantTransaction([], (context) => {
    result = context.state;
  });
  return result;
}
export function emptyState(owner: BoxRegistryCredentialOwner): GrantState {
  return {
    ...owner,
    tenantId: null,
    epoch: 0,
    mode: "observe",
    requestedSequence: 0,
    installedSequence: 0,
    keysetRevision: "",
    keys: [],
    retiredKids: [],
    clock: null,
  };
}
