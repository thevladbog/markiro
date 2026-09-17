import { z } from "zod";
import {
  replacementEvidenceRecoverySchema,
  deviceReplacementReadinessRequestSchema,
  deviceReplacementReadinessResponseSchema,
} from "@markiro/platform-contracts";
import type { SqlExecutor } from "./mirror.js";
import type { StationProvisioning } from "./pairing.js";
import {
  credentialGenerationOwnership,
  createCredentialGeneration,
  acquireCredentialCommitLease,
  type CredentialGeneration,
} from "./credential-recovery.js";
import { readReplacementMeasurements } from "./device-replacement.js";
export const RECOVERY_EVIDENCE_KEY = "replacement_evidence_recovery_v1";
const savedSchema = z
  .object({
    tenantId: z.string(),
    deviceId: z.string(),
    serverOrigin: z.string(),
    credentialOwnership: z.string(),
    recovery: replacementEvidenceRecoverySchema,
    sequence: z.number().int(),
    body: deviceReplacementReadinessRequestSchema.nullable(),
    completed: z.boolean(),
  })
  .strict();
export async function readReplacementEvidenceRecovery(exec: SqlExecutor) {
  const [row] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
    RECOVERY_EVIDENCE_KEY,
  ]);
  return row ? savedSchema.parse(JSON.parse(row.value)) : null;
}
export async function persistReplacementEvidenceRecovery(
  exec: SqlExecutor,
  p: StationProvisioning,
) {
  const old = await readReplacementEvidenceRecovery(exec);
  if (!p.recovery) {
    if (old) throw new Error("Evidence recovery purpose required");
    return;
  }
  const recovery = replacementEvidenceRecoverySchema.parse(p.recovery);
  const hash = await credentialGenerationOwnership(createCredentialGeneration(p.apiKey));
  if (!hash) throw new Error("Recovery credential missing");
  const next = savedSchema.parse({
    tenantId: p.tenantId,
    deviceId: p.deviceId,
    serverOrigin: new URL(p.serverUrl).origin,
    credentialOwnership: hash,
    recovery,
    sequence: -1,
    body: null,
    completed: false,
  });
  if (old) {
    if (
      old.tenantId !== next.tenantId ||
      old.deviceId !== next.deviceId ||
      old.serverOrigin !== next.serverOrigin ||
      old.recovery.executionId !== recovery.executionId ||
      old.recovery.credentialEpoch > recovery.credentialEpoch ||
      (old.recovery.credentialEpoch === recovery.credentialEpoch &&
        old.credentialOwnership !== hash)
    )
      throw new Error("Recovery owner changed");
    if (old.credentialOwnership === hash) return;
  }
  await exec.run(
    "INSERT INTO station_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    [RECOVERY_EVIDENCE_KEY, JSON.stringify(next)],
  );
  if (JSON.stringify(await readReplacementEvidenceRecovery(exec)) !== JSON.stringify(next))
    throw new Error("Evidence recovery publication failed");
}
export async function reportReplacementEvidenceRecovery(input: {
  exec: SqlExecutor;
  generation: CredentialGeneration;
  client: { post(path: string, body: unknown): Promise<unknown> };
  clientBuild: string;
}) {
  let saved = await readReplacementEvidenceRecovery(input.exec);
  if (!saved || saved.completed) return;
  const hash = await credentialGenerationOwnership(input.generation);
  if (input.generation.sealed || hash !== saved.credentialOwnership)
    throw new Error("Recovery credential changed");
  if (!saved.body) {
    const { highestSequence, ...measurements } = await readReplacementMeasurements(input.exec);
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(measurements)),
    );
    const digest = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join(
      "",
    );
    const body = deviceReplacementReadinessRequestSchema.parse({
      ...measurements,
      requestId: crypto.randomUUID(),
      intentId: saved.recovery.intentId,
      credentialEpoch: saved.recovery.credentialEpoch,
      reportSequence: saved.sequence + 1,
      storageRevision: saved.sequence + 2,
      clientBuild: input.clientBuild,
      journal: { digest, highestSequence },
    });
    const lease = acquireCredentialCommitLease(input.generation);
    if (!lease) throw new Error("Recovery credential changed");
    try {
      const next = { ...saved, sequence: body.reportSequence, body };
      await input.exec.run("UPDATE station_meta SET value=? WHERE key=? AND value=?", [
        JSON.stringify(next),
        RECOVERY_EVIDENCE_KEY,
        JSON.stringify(saved),
      ]);
      saved = await readReplacementEvidenceRecovery(input.exec);
      if (!saved?.body) throw new Error("Recovery report not persisted");
    } finally {
      lease.release();
    }
  }
  const response = deviceReplacementReadinessResponseSchema.parse(
    await input.client.post("/station/replacement-recovery/readiness", saved.body),
  );
  if (response.requestId !== saved.body?.requestId || response.intentId !== saved.recovery.intentId)
    throw new Error("Recovery acknowledgement mismatch");
  const lease = acquireCredentialCommitLease(input.generation);
  if (!lease) throw new Error("Recovery credential changed");
  try {
    await input.exec.run("UPDATE station_meta SET value=? WHERE key=? AND value=?", [
      JSON.stringify({
        ...saved,
        body: null,
        completed: response.eligibility.status === "eligible",
      }),
      RECOVERY_EVIDENCE_KEY,
      JSON.stringify(saved),
    ]);
  } finally {
    lease.release();
  }
}
