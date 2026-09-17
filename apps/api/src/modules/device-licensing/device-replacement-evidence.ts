import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException, PayloadTooLargeException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { productLabelValueDigest } from "@markiro/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { sanitizeEvidencePayload } from "../device-grants/evidence-core";
import { replacementTargetWaiting } from "./device-replacement-admission";

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
      code: z.literal("device_replacement_draining"),
      reason: z.literal("unproven_pre_drain_scope"),
      outcome: z.literal("quarantined"),
      receiptId: z.string().uuid(),
    })
    .strict(),
]);

/**
 * A target is created with its immutable execution fence in one transaction.
 * An existing device can never acquire a new incoming fence. This separate
 * retention transaction therefore cannot race a later introduction of waiting;
 * it commits the evidence before the legacy owner throws its HTTP conflict.
 * A source may enter draining later. Its fresh write-off admission also checks
 * under the same device lock; a rejected in-flight request returns here after
 * rollback to retain its unproven scope. Native envelopes use the existing
 * GrantEvidenceService receipt transaction.
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
  const [target] = await db
    .select({ id: schema.workingDeviceReplacementExecutions.id })
    .from(schema.workingDeviceReplacementExecutions)
    .where(
      and(
        eq(schema.workingDeviceReplacementExecutions.tenantId, tenantId),
        eq(schema.workingDeviceReplacementExecutions.targetDeviceId, deviceId),
      ),
    );
  if (!target && operation !== "writeoffs") return;
  const identity = productLabelValueDigest([
    "replacement-legacy-v1",
    tenantId,
    deviceId,
    operation,
    submissionId,
  ]);
  const digest = productLabelValueDigest(payload);
  const receipt = await db.transaction(async (tx) => {
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
      if (previous.payloadDigest !== digest)
        throw new ConflictException({ code: "device_replacement_evidence_conflict" });
      return receiptSchema.parse(previous.payload.receipt);
    }
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
    if ((!waiting && !source) || (await alreadyApplied?.(tx))) return null;
    const id = randomUUID();
    const response = receiptSchema.parse(
      waiting
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
    const scope = waiting ? { executionId: waiting.id } : { preparationId: source?.id };
    const reason =
      response.code === "device_replacement_draining" ? response.reason : response.code;
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
  });
  if (receipt) throw new ConflictException(receipt);
}
