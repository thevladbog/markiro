import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { productLabelValueDigest } from "@markiro/domain";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { sanitizeEvidencePayload } from "../device-grants/evidence-core";
import { replacementTargetWaiting } from "./device-replacement-admission";

/** The source fence is immutable after transfer, including after recovery is closed.
 * Caller holds the device lock. Server retention before startedAt proves the exact
 * submitted bytes existed before cutover; client timestamps/grants alone do not. */
export async function replacementSourceEvidenceBoundary(
  tx: SubscriptionTransaction,
  tenantId: string,
  deviceId: string,
  includeNormalTransfer = false,
) {
  const [execution] = await tx
    .select()
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        eq(schema.workingDeviceReplacementExecutions.deviceId, deviceId),
        includeNormalTransfer
          ? undefined
          : eq(schema.workingDeviceReplacementExecutions.mode, "emergency"),
        eq(schema.workingDeviceReplacementExecutions.state, "completed"),
      ),
    );
  return execution;
}

const receiptSchema = z.discriminatedUnion("code", [
  z
    .object({
      code: z.literal("device_replacement_waiting"),
      outcome: z.literal("quarantined"),
      receiptId: z.string().uuid(),
      newWorkAllowedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      code: z.literal("device_replacement_recovery"),
      reason: z.literal("unproven_pre_replacement_evidence"),
      outcome: z.literal("quarantined"),
      receiptId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      code: z.literal("device_replacement_draining"),
      reason: z.literal("unproven_pre_drain_scope"),
      outcome: z.literal("quarantined"),
      receiptId: z.string().uuid(),
    })
    .strict(),
]);

/**
 * A target is created with its immutable execution fence in one transaction.
 * This preflight can retain an already fenced request early, but is not admission:
 * every legacy owner repeats the decision inside its business transaction through
 * withReplacementTransaction. Native envelopes use their retained hook.
 */
export async function quarantineReplacementSubmission(
  db: Db,
  tenantId: string,
  deviceId: string,
  operation: string,
  submissionId: string,
  payload: object,
  alreadyApplied?: (tx: SubscriptionTransaction) => Promise<boolean>,
): Promise<void> {
  const [replacement] = await db
    .select({ id: schema.workingDeviceReplacementExecutions.id })
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        or(
          eq(schema.workingDeviceReplacementExecutions.targetDeviceId, deviceId),
          eq(schema.workingDeviceReplacementExecutions.deviceId, deviceId),
        ),
      ),
    );
  if (!replacement && operation !== "writeoffs") return;
  return withReplacementTransaction(
    db,
    {
      tenantId,
      deviceId,
      operation,
      submissionId,
      payload,
      ...(alreadyApplied ? { alreadyApplied } : {}),
    },
    () => Promise.resolve(undefined),
  );
}

export interface ReplacementSubmission {
  tenantId: string;
  deviceId: string;
  operation: string;
  submissionId: string;
  payload: object;
  alreadyApplied?: (tx: SubscriptionTransaction) => Promise<boolean>;
}

export async function preflightReplacementSubmission(
  db: Db,
  submission: ReplacementSubmission | undefined,
) {
  if (!submission) return;
  const { tenantId, deviceId, operation, submissionId, payload, alreadyApplied } = submission;
  return quarantineReplacementSubmission(
    db,
    tenantId,
    deviceId,
    operation,
    submissionId,
    payload,
    alreadyApplied,
  );
}

/** Device lock precedes all business locks and is held until commit. A losing
 * legacy submission commits only its quarantine receipt, never its business callback.
 * Native envelopes keep their own retained-receipt hook and supply no legacy descriptor. */
export async function withReplacementTransaction<T>(
  db: Db,
  submission: ReplacementSubmission | undefined,
  work: (tx: SubscriptionTransaction) => Promise<T>,
): Promise<T> {
  const outcome = await db.transaction(async (tx) => {
    const receipt = submission ? await retainReplacementSubmission(tx, submission) : null;
    if (receipt) return { receipt };
    return { result: await work(tx) };
  });
  if ("receipt" in outcome) throw new ConflictException(outcome.receipt);
  return outcome.result;
}

async function retainReplacementSubmission(
  tx: SubscriptionTransaction,
  submission: ReplacementSubmission,
) {
  const { tenantId, deviceId, operation, submissionId, payload, alreadyApplied } = submission;
  const identity = productLabelValueDigest([
    "replacement-legacy-v1",
    tenantId,
    deviceId,
    operation,
    submissionId,
  ]);
  const [device] = await tx
    .select()
    .from(schema.stationDevices)
    .where(
      and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
    )
    .for("update");
  if (!device || (device.kind !== "station" && device.kind !== "handheld"))
    throw new NotFoundException();
  const [previous] = await tx
    .select()
    .from(schema.deviceGrantEvidence)
    .where(
      and(
        eq(schema.deviceGrantEvidence.tenantId, tenantId),
        eq(schema.deviceGrantEvidence.evidenceIdentity, identity),
      ),
    );
  if (previous) {
    if (previous.payloadDigest !== productLabelValueDigest(payload))
      throw new ConflictException({ code: "device_replacement_evidence_conflict" });
    return receiptSchema.parse(previous.payload.receipt);
  }
  const recovery = await replacementSourceEvidenceBoundary(tx, tenantId, deviceId, true);
  const waiting = await replacementTargetWaiting(tx, tenantId, deviceId);
  const [source] =
    operation === "writeoffs"
      ? await tx
          .select({ id: schema.workingDeviceReplacementPreparations.id })
          .from(schema.workingDeviceReplacementPreparations)
          .where(
            and(
              eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
              eq(schema.workingDeviceReplacementPreparations.deviceId, deviceId),
              inArray(schema.workingDeviceReplacementPreparations.state, [
                "draining",
                "ready",
                "executing",
                "completed",
              ]),
            ),
          )
      : [];
  if ((!waiting && !source && !recovery) || (await alreadyApplied?.(tx))) return null;
  const digest = productLabelValueDigest(payload);
  const id = randomUUID();
  const response = receiptSchema.parse(
    recovery && !source
      ? {
          code: "device_replacement_recovery",
          reason: "unproven_pre_replacement_evidence",
          outcome: "quarantined",
          receiptId: id,
        }
      : waiting
        ? {
            code: "device_replacement_waiting",
            outcome: "quarantined",
            receiptId: id,
            newWorkAllowedAt: waiting.newWorkAllowedAt.toISOString(),
          }
        : {
            code: "device_replacement_draining",
            reason: "unproven_pre_drain_scope",
            outcome: "quarantined",
            receiptId: id,
          },
  );
  const scope = recovery
    ? { executionId: recovery.id }
    : waiting
      ? { executionId: waiting.id }
      : { preparationId: source?.id };
  const reason = "reason" in response ? response.reason : response.code;
  const retained = {
    operation,
    submissionId,
    ...scope,
    request: sanitizeEvidencePayload({ ...payload }),
    receipt: response,
  };
  // Match the existing quarantine table's bound using PostgreSQL's actual
  // JSONB representation, including its extra separator whitespace.
  const size = await tx.execute(
    sql`select octet_length(${JSON.stringify(retained)}::jsonb::text) as bytes`,
  );
  if (Number(size.rows[0]?.bytes) > 1_048_576)
    throw new PayloadTooLargeException({ code: "EVIDENCE_TOO_LARGE" });
  await tx.insert(schema.deviceGrantEvidence).values({
    id,
    tenantId,
    ownerKind: device.kind,
    stationDeviceId: deviceId,
    credentialEpoch: device.credentialEpoch,
    evidenceIdentity: identity,
    payloadDigest: digest,
    payload: retained,
    disposition: "quarantined",
    reason,
  });
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: tenantId,
    actorUserId: null,
    action: "device.replacement.evidence_quarantined",
    outcome: "failure",
    targetType: "device_grant_evidence",
    targetId: id,
    after: {
      tenantId,
      deviceId,
      credentialEpoch: device.credentialEpoch,
      ...scope,
      operation,
      submissionId,
      payloadDigest: digest,
      reason,
    },
  });
  return response;
}
