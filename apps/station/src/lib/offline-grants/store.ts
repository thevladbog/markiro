import { verifyGrant, type GrantOwner, type OfflineGrant } from "@markiro/domain";
import {
  grantEnvelopeSchema,
  grantKeysetSchema,
  type GrantEnvelope,
  type GrantKeyset,
} from "@markiro/platform-contracts";
import type { SqlExecutor } from "../mirror.js";
import { acquireCredentialCommitLease, type CredentialGeneration } from "../credential-recovery.js";
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
