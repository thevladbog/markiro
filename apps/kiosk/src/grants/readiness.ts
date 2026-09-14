import {
  grantClientReadinessRequestSchema,
  grantClientReadinessResponseSchema,
  type GrantClientReadinessRequest,
} from "@markiro/platform-contracts";
import packageMetadata from "../../package.json";
import type { KioskClient } from "../api/client.js";
import { readConfig } from "../store/config.js";
import {
  KIOSK_DB_VERSION,
  STORE_CONFIG,
  STORE_GRANT_READINESS,
  withStore,
  withTransaction,
} from "../store/db.js";
import {
  boxRegistryCredentialOwnerOf,
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { readGrantState } from "./store.js";

interface KioskGrantReadinessIntent {
  requestId: string;
  owner: BoxRegistryCredentialOwner;
  body: GrantClientReadinessRequest;
}

function parseIntent(value: unknown): KioskGrantReadinessIntent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { requestId?: unknown; owner?: unknown; body?: unknown };
  if (typeof row.requestId !== "string" || !row.owner || typeof row.owner !== "object") return null;
  const candidate = row.owner as {
    binding?: { serverUrl?: unknown; kioskId?: unknown };
    credentialGeneration?: unknown;
  };
  const owner = boxRegistryCredentialOwnerOf({
    serverUrl: candidate.binding?.serverUrl,
    kioskId: candidate.binding?.kioskId,
    credentialGeneration: candidate.credentialGeneration,
    token: "stored-readiness-owner",
  });
  const parsed = grantClientReadinessRequestSchema.safeParse(row.body);
  if (!owner || !parsed.success || parsed.data.requestId !== row.requestId) return null;
  return { requestId: row.requestId, owner, body: parsed.data };
}

async function intents(): Promise<KioskGrantReadinessIntent[]> {
  const rows =
    (await withStore<unknown[]>(STORE_GRANT_READINESS, "readonly", (store) => store.getAll())) ??
    [];
  return rows.map(parseIntent).filter((row): row is KioskGrantReadinessIntent => row !== null);
}

export async function prepareKioskGrantReadiness(
  owner: BoxRegistryCredentialOwner,
): Promise<KioskGrantReadinessIntent | null> {
  const existing = (await intents()).find((row) =>
    sameBoxRegistryCredentialOwner(row.owner, owner),
  );
  if (existing) return existing;
  const state = await readGrantState();
  const device = state?.device;
  if (
    !state?.configurationReceived ||
    !sameBoxRegistryCredentialOwner(state, owner) ||
    !device ||
    device.credentialGeneration !== owner.credentialGeneration ||
    state.keysetRevision === ""
  )
    return null;
  const requestId = crypto.randomUUID();
  const body = grantClientReadinessRequestSchema.parse({
    protocol: "offline-grants-v1",
    capability: "offline-grants-readiness-v1",
    requestId,
    clientBuild: `kiosk:${packageMetadata.version}`,
    storageRevision: KIOSK_DB_VERSION,
    installed: {
      mode: state.mode,
      policyRevision: state.policyRevision ?? null,
      keysetRevision: state.keysetRevision,
      verifiedGrantId: device.grant.grantId,
    },
  });
  const intent = { requestId, owner, body } satisfies KioskGrantReadinessIntent;
  let stored = false;
  await withTransaction([STORE_CONFIG, STORE_GRANT_READINESS], "readwrite", (tx) => {
    const configRequest = tx.objectStore(STORE_CONFIG).get("current");
    configRequest.onsuccess = () => {
      const current = boxRegistryCredentialOwnerOf(configRequest.result);
      if (!sameBoxRegistryCredentialOwner(current, owner)) return;
      tx.objectStore(STORE_GRANT_READINESS).add(intent);
      stored = true;
    };
  });
  return stored ? intent : null;
}

async function acknowledge(intent: KioskGrantReadinessIntent): Promise<boolean> {
  let deleted = false;
  await withTransaction([STORE_CONFIG, STORE_GRANT_READINESS], "readwrite", (tx) => {
    const configRequest = tx.objectStore(STORE_CONFIG).get("current");
    configRequest.onsuccess = () => {
      if (
        !sameBoxRegistryCredentialOwner(
          boxRegistryCredentialOwnerOf(configRequest.result),
          intent.owner,
        )
      )
        return;
      const store = tx.objectStore(STORE_GRANT_READINESS);
      const pendingRequest = store.get(intent.requestId);
      pendingRequest.onsuccess = () => {
        const pending = parseIntent(pendingRequest.result);
        if (!pending || !sameBoxRegistryCredentialOwner(pending.owner, intent.owner)) return;
        store.delete(intent.requestId);
        deleted = true;
      };
    };
  });
  return deleted;
}

export async function flushKioskGrantReadiness(
  client: Pick<KioskClient, "grantReadiness" | "registryOwner">,
): Promise<boolean> {
  if (!client.grantReadiness || !client.registryOwner) return false;
  let acknowledged = false;
  for (const intent of await intents()) {
    if (!sameBoxRegistryCredentialOwner(intent.owner, client.registryOwner)) continue;
    const current = boxRegistryCredentialOwnerOf(await readConfig());
    if (!sameBoxRegistryCredentialOwner(current, intent.owner)) continue;
    const response = grantClientReadinessResponseSchema.parse(
      await client.grantReadiness(intent.body),
    );
    if (response.requestId !== intent.requestId)
      throw new Error("offline grant readiness response identity mismatch");
    acknowledged = (await acknowledge(intent)) || acknowledged;
  }
  return acknowledged;
}
