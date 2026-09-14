import { productLabelValueDigest } from "@markiro/domain";
import {
  grantEvidenceEnvelopeSchema,
  type GrantEvidenceEnvelope,
} from "@markiro/platform-contracts";
import { z } from "zod";
import {
  acquireCredentialCommitLease,
  credentialGenerationOwnership,
  type CredentialGeneration,
} from "../credential-recovery.js";
import { credentialOwnsRetainedWork, deviceRecoveryAllowsWork } from "../device-recovery.js";
import type { SqlExecutor } from "../mirror.js";
import {
  buildStationEvidenceEnvelope,
  parseStationEvidenceReceipt,
  type SavedStationEvidenceLink,
} from "./evidence.js";

export class StationEvidenceRecoveryError extends Error {}

const pinSchema = z.strictObject({
  credentialOwnership: z.string().min(1),
  path: z.string(),
  envelope: grantEvidenceEnvelopeSchema,
  checkpoint: z.unknown(),
});
export type StationEvidencePin = z.infer<typeof pinSchema>;
const pinKey = (key: string) => `offline_grant_evidence_pin:${key}`;
const receiptKey = (key: string) => `offline_grant_evidence_receipt:${key}`;

export async function readStationSavedEvidence(
  exec: SqlExecutor,
  events: readonly { eventId: string; pointer: string }[],
): Promise<{ negotiated: boolean; links: SavedStationEvidenceLink[] }> {
  let negotiated = false;
  const links: SavedStationEvidenceLink[] = [];
  for (const event of events) {
    const [row] = await exec.all<{
      grant_id: string | null;
      compact: string | null;
      requested_grant: string;
    }>(
      `SELECT evidence.grant_id,evidence.compact,json_extract(command.payload_json,'$.grantId') requested_grant
       FROM offline_grant_event_evidence evidence
       JOIN offline_grant_event_commands command ON command.event_id=evidence.event_id
       JOIN offline_grant_decisions decision ON decision.event_id=evidence.event_id
       WHERE evidence.event_id=? AND json_extract(decision.decision_json,'$.allow')=1`,
      [event.eventId],
    );
    if (!row) continue;
    negotiated = true;
    if (row.grant_id && row.compact)
      links.push({ pointer: event.pointer, grantId: row.grant_id, compact: row.compact });
    else if (row.requested_grant !== "missing")
      throw new Error("station original evidence grant unavailable");
  }
  return { negotiated, links };
}

export async function readStationEvidencePin(
  exec: SqlExecutor,
  generation: CredentialGeneration,
  key: string,
): Promise<StationEvidencePin | null> {
  const [row] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
    pinKey(key),
  ]);
  if (!row) return null;
  const saved = z.strictObject({ pin: pinSchema, digest: z.string() }).parse(JSON.parse(row.value));
  if (
    productLabelValueDigest(saved.pin) !== saved.digest ||
    productLabelValueDigest(saved.pin.envelope.payload) !== saved.pin.envelope.payloadDigest
  )
    throw new Error("station evidence pin changed");
  if (
    !(await credentialOwnsRetainedWork(
      exec,
      await credentialGenerationOwnership(generation),
      saved.pin.credentialOwnership,
    ))
  )
    throw new Error("station evidence owner mismatch");
  return saved.pin;
}

export async function sendStationEvidence(input: {
  exec: SqlExecutor;
  client: { post(path: string, body?: unknown): Promise<unknown> };
  generation: CredentialGeneration;
  key: string;
  path: string;
  batchId: string;
  payload: unknown;
  links: readonly SavedStationEvidenceLink[];
  checkpoint?: unknown;
}): Promise<unknown> {
  const { exec, generation, key } = input;
  if (!(await deviceRecoveryAllowsWork(exec, generation)))
    throw new Error("station evidence owner retired");
  let pin = await readStationEvidencePin(exec, generation, key);
  if (!pin) {
    const owner = await credentialGenerationOwnership(generation);
    if (!owner) throw new Error("station evidence owner missing");
    const lease = acquireCredentialCommitLease(generation);
    if (!lease) throw new Error("station evidence owner retired");
    try {
      if (!(await deviceRecoveryAllowsWork(exec, generation)))
        throw new Error("station evidence owner retired");
      const candidate: StationEvidencePin = {
        credentialOwnership: owner,
        path: input.path,
        envelope: buildStationEvidenceEnvelope(input.batchId, input.payload, input.links),
        checkpoint: input.checkpoint ?? null,
      };
      const writer = await stationEvidenceCommitExecutor(exec, generation, owner);
      await writer.run(
        "INSERT INTO station_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
        [
          pinKey(key),
          JSON.stringify({ pin: candidate, digest: productLabelValueDigest(candidate) }),
        ],
      );
      pin = await readStationEvidencePin(exec, generation, key);
    } finally {
      lease.release();
    }
  }
  if (!pin || pin.path !== input.path || pin.envelope.batchId !== input.batchId)
    throw new Error("station evidence identity conflict");
  const envelope: GrantEvidenceEnvelope = pin.envelope;
  let [saved] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
    receiptKey(key),
  ]);
  if (!saved) {
    const value = await input.client.post(pin.path, envelope);
    const parsed = parseStationEvidenceReceipt(value, envelope);
    const lease = acquireCredentialCommitLease(generation);
    if (!lease) throw new Error("station evidence owner retired");
    try {
      if (
        !(await deviceRecoveryAllowsWork(exec, generation)) ||
        !(await readStationEvidencePin(exec, generation, key))
      )
        throw new Error("station evidence owner retired");
      const writer = await stationEvidenceCommitExecutor(exec, generation, pin.credentialOwnership);
      await writer.run(
        "INSERT INTO station_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING",
        [receiptKey(key), JSON.stringify(parsed.receipt)],
      );
      [saved] = await exec.all<{ value: string }>("SELECT value FROM station_meta WHERE key=?", [
        receiptKey(key),
      ]);
      if (!saved) throw new Error("station evidence receipt not durable");
      const first = parseStationEvidenceReceipt(JSON.parse(saved.value), envelope).receipt;
      if (
        productLabelValueDigest({ ...first, outcome: "duplicate" }) !==
        productLabelValueDigest({ ...parsed.receipt, outcome: "duplicate" })
      )
        throw new Error("station evidence receipt changed");
    } finally {
      lease.release();
    }
  }
  const parsed = parseStationEvidenceReceipt(JSON.parse(saved.value), envelope);
  if (parsed.native === null)
    throw new StationEvidenceRecoveryError(
      `station evidence requires recovery: ${parsed.receipt.reason ?? parsed.receipt.reconciliation.status}`,
    );
  return parsed.native;
}

/** Every mutation holds the same connection as its durable credential assertion. */
export async function stationEvidenceCommitExecutor(
  exec: SqlExecutor,
  generation: CredentialGeneration,
  originalOwner?: string,
): Promise<SqlExecutor> {
  const currentOwner = await credentialGenerationOwnership(generation);
  if (!currentOwner || generation.sealed || !exec.atomic)
    throw new Error("station evidence owner transaction unavailable");
  const atomic = exec.atomic.bind(exec);
  const guarded: NonNullable<SqlExecutor["atomic"]> = async (statements) => {
    if (generation.sealed) throw new Error("station evidence owner retired");
    const changes = await atomic([
      {
        sql: "INSERT INTO offline_grant_evidence_commit_guards(id,current_owner,original_owner) VALUES(1,?,?)",
        values: [currentOwner, originalOwner ?? currentOwner],
      },
      ...statements,
    ]);
    return changes.slice(1);
  };
  return {
    all: exec.all.bind(exec),
    atomic: guarded,
    async run(sql, values) {
      await guarded([{ sql, ...(values ? { values } : {}) }]);
    },
  };
}
