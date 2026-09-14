import {
  offlineGrantSchema,
  verifyGrant,
  type GrantOwner,
  type OfflineGrant,
} from "@markiro/domain";
import {
  grantClientReadinessRequestSchema,
  type GrantClientReadinessRequest,
  grantEnvelopeSchema,
  grantKeysetSchema,
  type GrantEnvelope,
  type GrantKeyset,
} from "@markiro/platform-contracts";
import type { SqlExecutor } from "../mirror.js";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "../credential-recovery.js";
import {
  assertExecutionScopeMatches,
  readInventoryExecutionProjection,
  readShiftExecutionProjection,
} from "./semantic.js";
export interface VerifiedStationGrantInstall {
  envelope: GrantEnvelope;
  grants: readonly { compact: string; kid: string; grant: OfflineGrant }[];
  snapshots: readonly {
    taskKind: string;
    taskId: string;
    snapshotDigest: string;
    canonical: string;
    scope: unknown;
  }[];
}

export const STATION_OFFLINE_GRANT_READINESS_STORAGE_REVISION = 1;

export interface StationGrantReadinessIntent {
  requestId: string;
  body: GrantClientReadinessRequest;
  credentialOwnership: string;
}
const sameOwner = (a: GrantOwner, b: GrantOwner) =>
  a.tenantId === b.tenantId &&
  a.deviceId === b.deviceId &&
  a.kind === b.kind &&
  a.credentialEpoch === b.credentialEpoch;
function compactKid(compact: string): string {
  const segment = compact.split(".")[0];
  if (!segment) throw new Error("offline grant protected header missing");
  const decoded = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  const header = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(decoded, (character) => character.charCodeAt(0)),
    ),
  ) as { kid?: unknown };
  if (typeof header.kid !== "string" || header.kid.length === 0)
    throw new Error("offline grant key id missing");
  return header.kid;
}
export async function verifyStationGrantEnvelope(
  raw: unknown,
  keysetRaw: unknown,
  expectedOwner: GrantOwner,
  expectedOrigin: string,
): Promise<VerifiedStationGrantInstall> {
  const envelope = grantEnvelopeSchema.parse(raw),
    keyset = grantKeysetSchema.parse(keysetRaw);
  if (
    !sameOwner(envelope.owner, expectedOwner) ||
    keyset.origin !== expectedOrigin ||
    new URL(expectedOrigin).origin !== expectedOrigin
  )
    throw new Error("offline grant owner/origin mismatch");
  const keys = keyset.keys
    .filter((k) => !keyset.retiredKids.includes(k.kid))
    .map((k) => ({
      kid: k.kid,
      origin: expectedOrigin,
      jwk: {
        kty: k.jwk.kty,
        crv: k.jwk.crv,
        x: k.jwk.x,
        y: k.jwk.y,
        ...(k.jwk.alg ? { alg: k.jwk.alg } : {}),
        ...(k.jwk.use ? { use: k.jwk.use } : {}),
      },
    }));
  const grants = [];
  for (const compact of envelope.grants) {
    const v = await verifyGrant(compact, keys, expectedOrigin);
    if (!v.ok) throw new Error(`offline grant verification failed: ${v.reason}`);
    if (!sameOwner(v.grant, expectedOwner)) throw new Error("offline grant owner mismatch");
    grants.push({ compact, kid: compactKid(compact), grant: v.grant });
  }
  const snapshots = [];
  for (const s of envelope.taskSnapshots) {
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.canonical))),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== s.snapshotDigest) throw new Error("offline grant canonical digest mismatch");
    const p = JSON.parse(s.canonical) as { taskKind?: unknown; taskId?: unknown; scope?: unknown };
    if (p.taskKind !== s.taskKind || p.taskId !== s.taskId || !("scope" in p))
      throw new Error("offline grant canonical binding mismatch");
    snapshots.push({ ...s, scope: p.scope });
  }
  const a = grants
      .flatMap((x) =>
        x.grant.kindOfGrant === "task"
          ? [`${x.grant.taskKind}\0${x.grant.taskId}\0${x.grant.snapshotDigest}`]
          : [],
      )
      .sort(),
    b = snapshots.map((x) => `${x.taskKind}\0${x.taskId}\0${x.snapshotDigest}`).sort();
  if (new Set(b).size !== b.length || a.length !== b.length || a.some((x, i) => x !== b[i]))
    throw new Error("offline grant task snapshot set mismatch");
  return { envelope, grants, snapshots };
}
export async function persistStationGrantInstall(
  exec: SqlExecutor,
  install: VerifiedStationGrantInstall,
  keyset: GrantKeyset,
  input: {
    requestSequence: number;
    authenticatedMode: "observe" | "strict";
    clock: { serverMs: number; monotonicMs: number; bootId: string; wallMs: number };
  },
): Promise<boolean> {
  const payload = {
    owner: install.envelope.owner,
    mode: input.authenticatedMode,
    keyset: {
      origin: keyset.origin,
      revision: keyset.revision,
      json: JSON.stringify(keyset),
      retiredKids: keyset.retiredKids,
    },
    grants: install.grants.map(({ compact, kid, grant }) => ({
      grantId: grant.grantId,
      kid,
      compact,
      json: JSON.stringify(grant),
      credentialEpoch: grant.credentialEpoch,
    })),
    snapshots: install.snapshots.map((s) => ({ ...s, scopeJson: JSON.stringify(s.scope) })),
    clock: input.clock,
  };
  try {
    await exec.run(
      "INSERT INTO offline_grant_install_commands(request_sequence,payload_json) VALUES(?,?)",
      [input.requestSequence, JSON.stringify(payload)],
    );
    return true;
  } catch (error) {
    if (
      /OFFLINE_GRANT_STALE_INSTALL|OFFLINE_GRANT_STALE_EPOCH|UNIQUE constraint failed: offline_grant_install_commands/.test(
        String(error),
      )
    )
      return false;
    throw error;
  }
}

export async function installStationGrant(input: {
  exec: SqlExecutor;
  envelope: GrantEnvelope;
  keyset: GrantKeyset;
  configuredOrigin: string;
  generation: CredentialGeneration;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
  requestSequence: number;
  clock: { serverMs: number; monotonicMs: number; bootId: string; wallMs: number };
}): Promise<boolean> {
  const retired = await input.exec.all<{ kid: string }>(
    "SELECT kid FROM offline_grant_retired_kids WHERE origin=?",
    [input.configuredOrigin],
  );
  const keyset = {
    ...input.keyset,
    retiredKids: [...new Set([...input.keyset.retiredKids, ...retired.map((row) => row.kid)])],
  };
  const expectedOwner: GrantOwner = {
    ...input.expectedDevice,
    credentialEpoch: input.envelope.owner.credentialEpoch,
  };
  const verified = await verifyStationGrantEnvelope(
    input.envelope,
    keyset,
    expectedOwner,
    input.configuredOrigin,
  );
  for (const snapshot of verified.snapshots) {
    if (snapshot.taskKind === "pickup")
      throw new Error("offline grant task kind is not supported by Station");
    const actual =
      snapshot.taskKind === "shift"
        ? await readShiftExecutionProjection(input.exec, snapshot.taskId)
        : await readInventoryExecutionProjection(input.exec, snapshot.taskId);
    assertExecutionScopeMatches(snapshot, actual);
  }
  if (input.clock.serverMs !== verified.envelope.serverTime) {
    throw new Error("offline grant clock anchor mismatch");
  }
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) return false;
  try {
    return await persistStationGrantInstall(input.exec, verified, keyset, {
      requestSequence: input.requestSequence,
      authenticatedMode: verified.envelope.mode,
      clock: input.clock,
    });
  } finally {
    lease.release();
  }
}

export async function hasStationReadinessDeviceGrant(input: {
  exec: SqlExecutor;
  configuredOrigin: string;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
}): Promise<boolean> {
  const rows = await readReadinessInstall(input);
  return rows.length === 1;
}

export async function prepareStationGrantReadiness(input: {
  exec: SqlExecutor;
  configuredOrigin: string;
  generation: CredentialGeneration;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
  clientBuild: string;
}): Promise<StationGrantReadinessIntent | null> {
  const credentialOwnership = await credentialGenerationOwnership(input.generation);
  if (!credentialOwnership) return null;
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) return null;
  try {
    const [row] = await readReadinessInstall(input);
    if (!row) return null;
    const grant = offlineGrantSchema.parse(JSON.parse(row.grant_json) as unknown);
    if (
      grant.kindOfGrant !== "device" ||
      grant.tenantId !== input.expectedDevice.tenantId ||
      grant.deviceId !== input.expectedDevice.deviceId ||
      grant.kind !== input.expectedDevice.kind ||
      grant.credentialEpoch !== row.credential_epoch ||
      grant.policyRevision !== row.policy_revision
    )
      return null;
    const stateKey = await readinessStateKey({
      credentialOwnership,
      requestSequence: row.request_sequence,
      mode: row.mode,
      policyRevision: row.policy_revision,
      keysetRevision: row.keyset_revision,
      grantId: grant.grantId,
      clientBuild: input.clientBuild,
      storageRevision: STATION_OFFLINE_GRANT_READINESS_STORAGE_REVISION,
    });
    const existing = await input.exec.all<ReadinessOutboxRow>(
      `SELECT request_id,body_json,credential_ownership,acknowledged_at,cancelled_at
         FROM offline_grant_readiness_outbox WHERE state_key=?`,
      [stateKey],
    );
    const saved = existing[0];
    if (saved) return pendingIntent(saved);
    const requestId = crypto.randomUUID();
    const body = grantClientReadinessRequestSchema.parse({
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      requestId,
      clientBuild: input.clientBuild,
      storageRevision: STATION_OFFLINE_GRANT_READINESS_STORAGE_REVISION,
      installed: {
        mode: row.mode,
        policyRevision: row.policy_revision,
        keysetRevision: row.keyset_revision,
        verifiedGrantId: grant.grantId,
      },
    });
    await input.exec.run(
      `INSERT OR IGNORE INTO offline_grant_readiness_outbox
        (request_id,state_key,body_json,credential_ownership) VALUES(?,?,?,?)`,
      [requestId, stateKey, JSON.stringify(body), credentialOwnership],
    );
    const [created] = await input.exec.all<ReadinessOutboxRow>(
      `SELECT request_id,body_json,credential_ownership,acknowledged_at,cancelled_at
         FROM offline_grant_readiness_outbox WHERE state_key=?`,
      [stateKey],
    );
    if (!created) throw new Error("offline grant readiness intent was not stored");
    return pendingIntent(created);
  } finally {
    lease.release();
  }
}

export async function markStationGrantReadinessAttempt(
  exec: SqlExecutor,
  intent: StationGrantReadinessIntent,
  generation: CredentialGeneration,
): Promise<boolean> {
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) return false;
  try {
    await exec.run(
      `UPDATE offline_grant_readiness_outbox SET attempts=attempts+1
        WHERE request_id=? AND credential_ownership=?
          AND acknowledged_at IS NULL AND cancelled_at IS NULL`,
      [intent.requestId, intent.credentialOwnership],
    );
    const [pending] = await exec.all<{ request_id: string }>(
      `SELECT request_id FROM offline_grant_readiness_outbox
        WHERE request_id=? AND credential_ownership=?
          AND acknowledged_at IS NULL AND cancelled_at IS NULL`,
      [intent.requestId, intent.credentialOwnership],
    );
    return pending?.request_id === intent.requestId;
  } finally {
    lease.release();
  }
}

export async function acknowledgeStationGrantReadiness(
  exec: SqlExecutor,
  intent: StationGrantReadinessIntent,
  generation: CredentialGeneration,
): Promise<boolean> {
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) return false;
  try {
    await exec.run(
      `UPDATE offline_grant_readiness_outbox SET acknowledged_at=CURRENT_TIMESTAMP
        WHERE request_id=? AND credential_ownership=?
          AND acknowledged_at IS NULL AND cancelled_at IS NULL`,
      [intent.requestId, intent.credentialOwnership],
    );
    const [acknowledged] = await exec.all<{ acknowledged_at: string | null }>(
      "SELECT acknowledged_at FROM offline_grant_readiness_outbox WHERE request_id=?",
      [intent.requestId],
    );
    return typeof acknowledged?.acknowledged_at === "string";
  } finally {
    lease.release();
  }
}

interface ReadinessInstallRow {
  credential_epoch: number;
  request_sequence: number;
  mode: "observe" | "strict";
  policy_revision: string | null;
  keyset_revision: string;
  grant_json: string;
}

interface ReadinessOutboxRow {
  request_id: string;
  body_json: string;
  credential_ownership: string;
  acknowledged_at: string | null;
  cancelled_at: string | null;
}

function readReadinessInstall(input: {
  exec: SqlExecutor;
  configuredOrigin: string;
  expectedDevice: Pick<GrantOwner, "tenantId" | "deviceId" | "kind">;
}): Promise<ReadinessInstallRow[]> {
  return input.exec.all<ReadinessInstallRow>(
    `SELECT config.credential_epoch,config.request_sequence,config.mode,
            config.policy_revision,keyset.revision keyset_revision,grant.grant_json
       FROM offline_grant_configuration config
       JOIN offline_grant_install_state state
         ON state.id=config.id AND state.tenant_id=config.tenant_id
        AND state.device_id=config.device_id AND state.owner_kind=config.owner_kind
        AND state.credential_epoch=config.credential_epoch
       JOIN offline_grant_keysets keyset ON keyset.origin=?
       JOIN offline_grant_grants grant
         ON json_extract(grant.grant_json,'$.kindOfGrant')='device'
        AND json_extract(grant.grant_json,'$.tenantId')=config.tenant_id
        AND json_extract(grant.grant_json,'$.deviceId')=config.device_id
        AND json_extract(grant.grant_json,'$.kind')=config.owner_kind
        AND json_extract(grant.grant_json,'$.credentialEpoch')=config.credential_epoch
        AND json_extract(grant.grant_json,'$.policyRevision') IS config.policy_revision
      WHERE config.id=1 AND config.tenant_id=? AND config.device_id=? AND config.owner_kind=?
      ORDER BY grant.installed_sequence DESC LIMIT 1`,
    [
      input.configuredOrigin,
      input.expectedDevice.tenantId,
      input.expectedDevice.deviceId,
      input.expectedDevice.kind,
    ],
  );
}

function pendingIntent(row: ReadinessOutboxRow): StationGrantReadinessIntent | null {
  if (row.acknowledged_at !== null || row.cancelled_at !== null) return null;
  const body = grantClientReadinessRequestSchema.parse(JSON.parse(row.body_json) as unknown);
  if (body.requestId !== row.request_id)
    throw new Error("offline grant readiness identity mismatch");
  return {
    requestId: row.request_id,
    body,
    credentialOwnership: row.credential_ownership,
  };
}

async function readinessStateKey(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
