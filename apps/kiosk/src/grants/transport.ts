import { draftKey } from "./drafts.js";
import {
  preparePickupBinding,
  commitPickupBinding,
  pickupEvidenceKey,
  PICKUP_BINDING_STORES,
} from "./task-binding.js";
import { verifyGrant } from "@markiro/domain";
import {
  grantIssueResultSchema,
  grantKeysetResultSchema,
  grantConfigurationSchema,
} from "@markiro/platform-contracts";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { clockSample, type ClockSample } from "./clock.js";
import {
  runChecked,
  emptyState,
  readGrantState,
  withGrantTransaction,
  type GrantContext,
  type StoredGrant,
} from "./store.js";

function grantOrigin(owner: BoxRegistryCredentialOwner): string {
  const url = new URL(owner.binding.serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("grant_keyset_origin");
  return url.origin;
}
export interface GrantRequestLease {
  owner: BoxRegistryCredentialOwner;
  sequence: number;
  started: ClockSample;
}
export async function beginGrantRequest(): Promise<GrantRequestLease | null> {
  let lease: GrantRequestLease | null = null;
  await withGrantTransaction([], (context) => {
    if (!context.owner) return;
    const state = context.state ?? emptyState(context.owner);
    const sequence = state.requestedSequence + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("grant_request_sequence_exhausted");
    lease = { owner: context.owner, sequence, started: clockSample() };
    context.store.put(
      {
        ...state,
        credentialGeneration: context.owner.credentialGeneration,
        requestedSequence: sequence,
      },
      context.key,
    );
  });
  return lease;
}
function current(context: GrantContext, lease: GrantRequestLease): boolean {
  return (
    sameBoxRegistryCredentialOwner(context.owner, lease.owner) &&
    context.state?.requestedSequence === lease.sequence
  );
}
export async function installGrantKeyset(
  lease: GrantRequestLease,
  response: unknown,
): Promise<boolean> {
  const result = grantKeysetResultSchema.parse(response);
  if ("status" in result) return false;
  if (result.origin !== grantOrigin(lease.owner)) throw new Error("grant_keyset_origin");
  let installed = false;
  await withGrantTransaction([], (context) => {
    if (!current(context, lease) || !context.state) return;
    const keys = [...context.state.keys];
    for (const key of result.keys) {
      const old = keys.find((value) => value.kid === key.kid);
      if (
        old &&
        (old.origin !== result.origin || old.jwk.x !== key.jwk.x || old.jwk.y !== key.jwk.y)
      )
        throw new Error("grant_key_identity_changed");
      if (!old)
        keys.push({
          kid: key.kid,
          origin: result.origin,
          jwk: {
            kty: key.jwk.kty,
            crv: key.jwk.crv,
            x: key.jwk.x,
            y: key.jwk.y,
            ...(key.jwk.alg ? { alg: key.jwk.alg } : {}),
            ...(key.jwk.use ? { use: key.jwk.use } : {}),
          },
        });
    }
    context.store.put(
      {
        ...context.state,
        keys,
        retiredKids: [...new Set([...context.state.retiredKids, ...result.retiredKids])],
        keysetRevision: result.revision,
      },
      context.key,
    );
    installed = true;
  });
  return installed;
}
export async function installGrantResponse(
  lease: GrantRequestLease,
  response: unknown,
  deviceSeq?: number,
): Promise<boolean> {
  const result = grantIssueResultSchema.parse(response);
  if (result.status === "denied") return false;
  const { envelope } = result;
  const snapshot = await readGrantState();
  if (!snapshot) return false;
  const owner = envelope.owner;
  if (
    owner.deviceId !== lease.owner.binding.kioskId ||
    owner.kind !== "kiosk" ||
    (snapshot.tenantId !== null && owner.tenantId !== snapshot.tenantId)
  )
    throw new Error("grant_owner_mismatch");
  const verified: StoredGrant[] = [];
  for (const compact of envelope.grants) {
    const result = await verifyGrant(compact, snapshot.keys, grantOrigin(lease.owner));
    if (!result.ok) throw new Error(`grant_${result.reason}`);
    const grant = result.grant;
    if (
      grant.tenantId !== owner.tenantId ||
      grant.deviceId !== owner.deviceId ||
      grant.kind !== owner.kind ||
      grant.credentialEpoch !== owner.credentialEpoch
    )
      throw new Error("grant_owner_mismatch");
    const header = compact.split(".")[0];
    if (!header) throw new Error("grant_header");
    const kid: unknown = (
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(header.replace(/-/g, "+").replace(/_/g, "/")), (character) =>
            character.charCodeAt(0),
          ),
        ),
      ) as { kid: unknown }
    ).kid;
    if (typeof kid !== "string") throw new Error("grant_header");
    if (snapshot.retiredKids.includes(kid)) throw new Error("grant_retired_key");
    verified.push({ grant, compact, kid, credentialGeneration: lease.owner.credentialGeneration });
  }
  const saved = verified[0];
  if (verified.length !== 1 || !saved) throw new Error("grant_response_shape");
  const task = saved.grant.kindOfGrant === "task" ? saved.grant : null;
  if (task && deviceSeq === undefined) throw new Error("grant_task_binding_required");
  const binding =
    task && deviceSeq !== undefined
      ? await preparePickupBinding(lease, task, envelope.taskSnapshots, deviceSeq)
      : null;
  if (!task && envelope.taskSnapshots.length) throw new Error("grant_response_shape");
  let installed = false;
  await withGrantTransaction(binding ? PICKUP_BINDING_STORES : [], (context) => {
    if (!current(context, lease) || !context.state) return;
    const state = context.state;
    const commit = () => {
      const sample = clockSample();
      if (sample.bootId !== lease.started.bootId || sample.monotonicMs < lease.started.monotonicMs)
        throw new Error("grant_clock_untrusted");
      if (
        (state.tenantId !== null && state.tenantId !== owner.tenantId) ||
        owner.credentialEpoch < state.epoch
      )
        throw new Error("grant_owner_mismatch");
      if (verified.some((value) => state.retiredKids.includes(value.kid)))
        throw new Error("grant_retired_key");
      const now = envelope.serverTime + sample.monotonicMs - lease.started.monotonicMs;
      if (
        !Number.isSafeInteger(now) ||
        envelope.serverTime < Math.max(state.serverHighWaterMs ?? 0, state.clock?.serverMs ?? 0) ||
        now < (state.clock?.highWaterMs ?? 0)
      )
        throw new Error("grant_clock_regressed");
      const historyKey = JSON.stringify([
        "grant",
        lease.owner.binding.serverUrl,
        saved.grant.tenantId,
        saved.grant.deviceId,
        saved.grant.grantId,
      ]);
      const historyRequest = context.store.get(historyKey);
      historyRequest.onsuccess = () =>
        runChecked(context.tx, () => {
          const previous = historyRequest.result as StoredGrant | undefined;
          if (previous && previous.compact !== saved.compact)
            throw new Error("grant_history_conflict");
          if (!previous) context.store.add(saved, historyKey);
        });
      context.store.put(
        {
          ...state,
          tenantId: owner.tenantId,
          epoch: owner.credentialEpoch,
          mode: state.mode,
          clockTrusted: true,
          serverHighWaterMs: Math.max(state.serverHighWaterMs ?? 0, envelope.serverTime),
          installedSequence: lease.sequence,
          ...(!task ? { device: saved } : {}),
          clock: {
            serverMs: envelope.serverTime,
            monotonicMs: lease.started.monotonicMs,
            bootId: sample.bootId,
            highWaterMs: now,
            wallHighWaterMs: sample.wallMs,
          },
        },
        context.key,
      );
      if (task && binding)
        context.store.put(
          {
            ...saved,
            canonical: binding.canonical,
            scope: binding.scope,
            deviceSeq: binding.deviceSeq,
            purpose: binding.draft ? "reserved_draft" : "accepted_order_evidence",
          },
          pickupEvidenceKey(context, task),
        );
      if (binding?.draft)
        context.store.put(
          { ...binding.queue, taskReady: true },
          draftKey(lease.owner, binding.deviceSeq),
        );
      installed = true;
    };
    if (binding) commitPickupBinding(context, lease, binding, commit);
    else commit();
  });
  return installed;
}

/** Authenticated recovery configuration is independent from entitlement to new work. */
export async function installGrantConfiguration(
  lease: GrantRequestLease,
  response: unknown,
): Promise<boolean> {
  const config = grantConfigurationSchema.parse(response),
    snapshot = await readGrantState();
  if (
    config.owner.deviceId !== lease.owner.binding.kioskId ||
    config.owner.kind !== "kiosk" ||
    (snapshot?.tenantId != null && snapshot.tenantId !== config.owner.tenantId)
  )
    throw Error("grant_owner_mismatch");
  if (config.keyset && !(await installGrantKeyset(lease, config.keyset))) return false;
  let installed = false;
  await withGrantTransaction([], (context) => {
    if (!current(context, lease) || !context.state) return;
    const state = context.state,
      sample = clockSample(),
      now = config.serverTime + sample.monotonicMs - lease.started.monotonicMs;
    if (
      (state.tenantId !== null && state.tenantId !== config.owner.tenantId) ||
      config.owner.credentialEpoch < state.epoch
    )
      throw Error("grant_owner_mismatch");
    const clockRejected =
      sample.bootId !== lease.started.bootId ||
      sample.monotonicMs < lease.started.monotonicMs ||
      !Number.isSafeInteger(now) ||
      config.serverTime < Math.max(state.serverHighWaterMs ?? 0, state.clock?.serverMs ?? 0) ||
      now < (state.clock?.highWaterMs ?? 0);
    context.store.put(
      {
        ...state,
        tenantId: config.owner.tenantId,
        configurationReceived: true,
        epoch: config.owner.credentialEpoch,
        mode: config.policyRevision !== null ? config.mode : state.mode,
        policyRevision: config.policyRevision,
        clockTrusted: !clockRejected,
        serverHighWaterMs: Math.max(
          state.serverHighWaterMs ?? 0,
          state.clock?.serverMs ?? 0,
          config.serverTime,
        ),
        installedSequence: lease.sequence,
        clock: clockRejected
          ? state.clock
          : {
              serverMs: config.serverTime,
              monotonicMs: lease.started.monotonicMs,
              bootId: sample.bootId,
              highWaterMs: now,
              wallHighWaterMs: sample.wallMs,
            },
      },
      context.key,
    );
    installed = true;
  });
  return installed;
}
