import { applyProductLabelEvent, DomainError, productLabelValueDigest } from "@markiro/domain";
import { recordScan } from "../journal.js";
import { recordScanWithOfflineGrant } from "../journal.js";
import type { SqlExecutor } from "../mirror.js";
import { acquireCredentialCommitLease, type CredentialGeneration } from "../credential-recovery.js";
import {
  StationGrantAdmission,
  stationOperatorIsCurrentlyActive,
} from "../offline-grants/admission.js";
import { sampleGrantClock, type GrantClockSample } from "../offline-grants/clock.js";
import { readExecutionToBind, readShiftExecutionProjection } from "../offline-grants/semantic.js";
import type { PreparedProductLabelAcceptance, ProductLabelAcceptResult } from "./types.js";
import { parseProductLabelAcceptance } from "./validation.js";

export function assertPreparedLabelMatchesExecution(
  value: PreparedProductLabelAcceptance,
  execution: Awaited<ReturnType<typeof readShiftExecutionProjection>>,
): void {
  const { shift, product } = execution.scope;
  const policyMatches =
    shift.validationPrintMode === value.policy.mode &&
    shift.allowPreviouslyAcceptedCodes === (value.policy.allowPreviouslyAcceptedCodes ?? false) &&
    shift.validationPrintVerification === value.policy.verification &&
    shift.validationPrintTemplateId === value.policy.templateId &&
    shift.validationPrintPolicyRevision === value.policy.policyRevision &&
    productLabelValueDigest(shift.validationPrintSnapshot) ===
      productLabelValueDigest(value.policy.snapshot);
  const fieldsMatch =
    value.gtin14 === product.gtin14 &&
    value.fields["product.name"] === product.name &&
    value.fields["product.printName"] === (product.printName ?? product.name) &&
    value.fields["product.gtin"] === product.gtin14 &&
    value.fields["product.egais"] === (product.egaisCode ?? "") &&
    value.fields["shift.no"] === shift.number &&
    value.fields["counterparty.name"] === (shift.counterpartyName ?? "");
  if (!policyMatches || !fieldsMatch)
    throw new Error("offline grant prepared label execution changed");
}

/** One INSERT invokes a SQLite trigger; no transaction may span calls on the Tauri SQL pool. */
async function recordProductLabelAcceptanceLegacy(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<ProductLabelAcceptResult> {
  const value = parseProductLabelAcceptance(input);
  const digest = productLabelValueDigest(value);
  const projection = applyProductLabelEvent(null, value.preparedEvent, value.policy.verification);
  try {
    await exec.run(
      `INSERT INTO product_label_accept_commands
       (credential_ownership, job_id, shift_id, terminal_id, operator_id, raw, code_hash,
        gtin14, serial, accepted_at, acceptance_json, command_digest, projection_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(credential_ownership, job_id) DO NOTHING`,
      [
        value.credentialOwnership,
        value.jobId,
        value.shiftId,
        value.terminalId,
        value.operatorId,
        value.raw,
        value.codeHash,
        value.gtin14,
        value.serial,
        value.acceptedAt,
        JSON.stringify(value),
        digest,
        JSON.stringify(projection),
      ],
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("PRODUCT_LABEL_BUSY")) return { status: "busy" };
    // Only this exact constraint means a duplicate unit. Other unique/write failures must surface.
    if (
      message.includes("VALIDATION_CODE_DUPLICATE") ||
      /UNIQUE constraint failed: codes_mirror\.code_hash(?:\s|$)/i.test(message)
    ) {
      await recordScan(
        exec,
        {
          shiftId: value.shiftId,
          terminalId: value.terminalId,
          raw: value.raw,
          verdict: "duplicate",
          scannedAt: value.acceptedAt,
          operatorId: value.operatorId,
        },
        null,
      );
      return { status: "duplicate" };
    }
    throw error;
  }
  const [stored] = await exec.all<{ command_digest: string; acceptance_json: string }>(
    "SELECT command_digest, acceptance_json FROM product_label_accept_commands WHERE credential_ownership = ? AND job_id = ?",
    [value.credentialOwnership, value.jobId],
  );
  if (
    !stored ||
    (stored.command_digest !== digest &&
      !(
        productLabelValueDigest(JSON.parse(stored.acceptance_json)) === stored.command_digest &&
        productLabelValueDigest(parseProductLabelAcceptance(JSON.parse(stored.acceptance_json))) ===
          digest
      ))
  ) {
    throw new DomainError(
      "PRODUCT_LABEL_ACCEPTANCE_ID_CONFLICT",
      "Product label job ID already carries different acceptance data",
    );
  }
  return { status: "accepted", jobId: value.jobId };
}

export async function recordProductLabelAcceptance(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
): Promise<ProductLabelAcceptResult> {
  const [active] = await exec.all<{ active: number }>(
    "SELECT 1 active FROM offline_grant_install_state WHERE id=1",
  );
  if (active?.active === 1) throw new Error("offline grant-aware product label owner required");
  return recordProductLabelAcceptanceLegacy(exec, input);
}

/** Grant-aware preparation owner; command trigger and allowance charge share one native transaction. */
export async function recordProductLabelAcceptanceWithOfflineGrant(
  exec: SqlExecutor,
  input: PreparedProductLabelAcceptance,
  generation: CredentialGeneration,
  clock: () => Promise<GrantClockSample> = sampleGrantClock,
): Promise<ProductLabelAcceptResult> {
  const lease = acquireCredentialCommitLease(generation);
  if (!lease) throw new Error("offline grant stale credential");
  try {
    const value = parseProductLabelAcceptance(input);
    const digest = productLabelValueDigest(value);
    const projection = applyProductLabelEvent(null, value.preparedEvent, value.policy.verification);
    const [state] = await exec.all<{
      tenant_id: string;
      device_id: string;
      owner_kind: "station";
      credential_epoch: number;
      mode: "observe" | "strict";
    }>(
      "SELECT tenant_id,device_id,owner_kind,credential_epoch,mode FROM offline_grant_install_state WHERE id=1",
    );
    if (!state) return recordProductLabelAcceptanceLegacy(exec, input);
    // An already committed native acceptance remains recovery; installing grants
    // must never retrocharge its original scan or print job.
    const [prior] = await exec.all<{ command_digest: string }>(
      "SELECT command_digest FROM product_label_accept_commands WHERE credential_ownership=? AND job_id=?",
      [value.credentialOwnership, value.jobId],
    );
    if (prior) {
      if (prior.command_digest !== digest) throw new Error("offline grant label replay mismatch");
      return { status: "accepted", jobId: value.jobId };
    }

    if (!(await stationOperatorIsCurrentlyActive(exec, value.operatorId)))
      throw new Error("offline grant operator unauthorized");
    const [binding] = await exec.all<{ snapshot_digest: string }>(
      `SELECT json_extract(grant_json,'$.snapshotDigest') snapshot_digest
       FROM offline_grant_grants
      WHERE json_extract(grant_json,'$.kindOfGrant')='task'
        AND json_extract(grant_json,'$.taskKind')='shift'
        AND json_extract(grant_json,'$.taskId')=?
      ORDER BY installed_sequence DESC LIMIT 1`,
      [value.shiftId],
    );
    const result = { status: "accepted" as const, jobId: value.jobId };
    try {
      // A device that cannot bind the shift has no grant to charge. Strict mode
      // must refuse rather than print an unbound duplicate; observe mode records
      // production exactly as a device without grant state does, because an
      // observing station has no authority to stop the line -- and refusing here
      // stopped it at the first scan, before anything printed.
      const execution = await readExecutionToBind(state.mode, () =>
        readShiftExecutionProjection(exec, value.shiftId),
      );
      if (!execution) return recordProductLabelAcceptanceLegacy(exec, input);
      assertPreparedLabelMatchesExecution(value, execution);
      const part = {
        operatorId: value.operatorId,
        intent: {
          owner: {
            tenantId: state.tenant_id,
            deviceId: state.device_id,
            kind: state.owner_kind,
            credentialEpoch: state.credential_epoch,
          },
          capability: "shift.start.v1" as const,
          taskId: value.shiftId,
          snapshotDigest: binding?.snapshot_digest ?? "missing",
          eventId: value.preparedEvent.eventId,
          eventType: "shift.label.prepare.v1" as const,
          cost: {},
        },
        execution,
        event: value,
        facts: { units: 1 },
        result,
      };
      const committed = await new StationGrantAdmission(exec, clock).commitCompletionPair({
        first: {
          ...part,
          intent: {
            ...part.intent,
            eventId: `${value.preparedEvent.eventId}#shift.scan.v1`,
            eventType: "shift.scan.v1",
          },
          result: { ...result, scanOutbox: true },
        },
        second: part,
        ownerStatements: [
          {
            sql: `INSERT INTO product_label_accept_commands
          (credential_ownership,job_id,shift_id,terminal_id,operator_id,raw,code_hash,gtin14,serial,accepted_at,acceptance_json,command_digest,projection_json)
          SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?
          WHERE json_extract((SELECT decision_json FROM offline_grant_decisions WHERE event_id=?),'$.allow')=1`,
            values: [
              value.credentialOwnership,
              value.jobId,
              value.shiftId,
              value.terminalId,
              value.operatorId,
              value.raw,
              value.codeHash,
              value.gtin14,
              value.serial,
              value.acceptedAt,
              JSON.stringify(value),
              digest,
              JSON.stringify(projection),
              value.preparedEvent.eventId,
            ],
          },
        ],
      });
      if (!committed.first.allow || !committed.second.allow)
        throw new Error(
          `offline grant denied: ${committed.first.reason ?? committed.second.reason}`,
        );
      return result;
    } catch (error) {
      if (!/UNIQUE constraint failed: codes_mirror\.code_hash/i.test(String(error))) throw error;
      await recordScanWithOfflineGrant(
        exec,
        {
          eventId: value.preparedEvent.eventId,
          shiftId: value.shiftId,
          terminalId: value.terminalId,
          raw: value.raw,
          verdict: "duplicate",
          scannedAt: value.acceptedAt,
          operatorId: value.operatorId,
        },
        null,
        generation,
        clock,
      );
      return { status: "duplicate" };
    }
  } finally {
    lease.release();
  }
}
