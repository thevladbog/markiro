import { randomUUID } from "node:crypto";
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  deviceReplacementEmergencyPreviewRequestSchema,
  deviceReplacementExecuteRequestSchema,
  deviceReplacementExecutionPreviewRequestSchema,
  deviceReplacementExecutionPreviewSchema,
  deviceReplacementObservationSchema,
  deviceReplacementReceiptSchema,
  platformUuidSchema,
  type DeviceReplacementEmergencyPreviewRequest,
  type DeviceReplacementExecuteRequest,
  type DeviceReplacementExecutionPreviewRequest,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { transitionWorkingAssignment } from "../../subscriptions/working-device-assignments";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { lockGrantFacts } from "../device-grants/grant-admission";
import { createStationDeviceSchema } from "../station-devices/dto";
import {
  requireDeviceLicensingActor,
  type DeviceLicensingActor,
} from "./device-licensing-authority";
import { readDeviceReplacementFacts, replacementDigest } from "./device-replacement-facts";
import { replacementPreparationProjection } from "./device-replacement-readiness-projection";
import { deviceReplacementServerWorkBlockers } from "./device-replacement-readiness-work";
import {
  executionConflict,
  readReplacementExecutionFacts,
} from "./device-replacement-execution-facts";

const executions = schema.workingDeviceReplacementExecutions;
const previews = schema.workingDeviceReplacementExecutionPreviews;
const preparations = schema.workingDeviceReplacementPreparations;
type Preview = typeof previews.$inferSelect;
type Execution = typeof executions.$inferSelect;
function publicPreview(row: Preview) {
  return deviceReplacementExecutionPreviewSchema.parse({
    id: row.id,
    requestId: row.requestId,
    preparationId: row.preparationId,
    expectedRevision: row.expectedRevision,
    mode: row.mode,
    asOf: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    digest: row.factsFingerprint,
    newWorkAllowedAt: row.newWorkAllowedAt.toISOString(),
  });
}
function validateId(id: string) {
  if (!platformUuidSchema.safeParse(id).success) throw new BadRequestException();
}

@Injectable()
export class DeviceReplacementExecutionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}
  private transaction<T>(tenantId: string, action: (tx: SubscriptionTransaction) => Promise<T>) {
    return this.db.transaction(
      async (tx) => {
        await lockGrantFacts(tx, tenantId, this.entitlements);
        return action(tx);
      },
      { isolationLevel: "read committed" },
    );
  }
  previewExecution(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementExecutionPreviewRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementExecutionPreviewRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException();
    return this.preview(tenantId, preparationId, parsed.data, "normal", null, actor);
  }
  previewEmergency(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementEmergencyPreviewRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementEmergencyPreviewRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException();
    return this.preview(
      tenantId,
      preparationId,
      parsed.data,
      "emergency",
      parsed.data.reason,
      actor,
    );
  }
  private async preview(
    tenantId: string,
    preparationId: string,
    request: DeviceReplacementExecutionPreviewRequest,
    mode: "normal" | "emergency",
    reason: string | null,
    actor: DeviceLicensingActor,
  ) {
    validateId(preparationId);
    const hash = replacementDigest({
      operation: "execution_preview",
      preparationId,
      ...request,
      mode,
      reason,
    });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const row = await this.preparation(tx, tenantId, preparationId);
      const [existing] = await tx
        .select()
        .from(previews)
        .where(
          and(
            eq(previews.tenantId, tenantId),
            eq(previews.actorDomain, actor.domain),
            eq(previews.requestId, request.requestId),
          ),
        );
      if (
        existing &&
        (existing.requestHash !== hash ||
          existing.actorId !== authority.id ||
          existing.preparationId !== row.id)
      )
        executionConflict("request_conflict");
      await this.requireUnusedRequest(tx, tenantId, request.requestId);
      if (
        !["prepared", "draining", "ready"].includes(row.state) ||
        row.revision !== request.expectedRevision
      )
        executionConflict();
      const now = new Date();
      const expiresAt = existing?.expiresAt ?? new Date(now.getTime() + 60_000);
      if (now >= expiresAt) executionConflict();
      const facts = await readReplacementExecutionFacts(
        tx,
        row,
        mode,
        this.entitlements,
        now,
        expiresAt,
      );
      if (existing) {
        if (existing.factsFingerprint !== facts.digest) executionConflict();
        return publicPreview(existing);
      }
      const [preview] = await tx
        .insert(previews)
        .values({
          tenantId,
          deviceId: row.deviceId,
          preparationId,
          actorDomain: actor.domain,
          actorId: authority.id,
          requestId: request.requestId,
          requestHash: hash,
          expectedRevision: request.expectedRevision,
          mode,
          emergencyReason: reason,
          factsFingerprint: facts.digest,
          createdAt: now,
          expiresAt,
          newWorkAllowedAt: facts.boundary,
        })
        .returning();
      if (!preview) throw new Error("Execution preview insert failed");
      return publicPreview(preview);
    });
  }
  executeNormal(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementExecuteRequest,
    actor: DeviceLicensingActor,
  ) {
    return this.execute(tenantId, preparationId, input, "normal", actor);
  }
  executeEmergency(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementExecuteRequest,
    actor: DeviceLicensingActor,
  ) {
    return this.execute(tenantId, preparationId, input, "emergency", actor);
  }
  private async execute(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementExecuteRequest,
    mode: "normal" | "emergency",
    actor: DeviceLicensingActor,
  ) {
    validateId(preparationId);
    const parsed = deviceReplacementExecuteRequestSchema.safeParse(input);
    if (!parsed.success || parsed.data.mode !== mode) throw new BadRequestException();
    const request = parsed.data;
    const hash = replacementDigest({ operation: "execute", preparationId, ...request });
    await this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const row = await this.preparation(tx, tenantId, preparationId);
      const existing = await this.execution(tx, tenantId, preparationId);
      if (existing) {
        if (
          existing.requestId !== request.requestId ||
          existing.requestHash !== hash ||
          existing.actorDomain !== actor.domain ||
          existing.actorId !== authority.id
        )
          executionConflict("request_conflict");
        return;
      }
      await this.requireUnusedRequest(tx, tenantId, request.requestId);
      const [preview] = await tx
        .select()
        .from(previews)
        .where(
          and(
            eq(previews.tenantId, tenantId),
            eq(previews.id, request.previewId),
            eq(previews.preparationId, preparationId),
          ),
        );
      if (!preview) throw new NotFoundException();
      if (
        preview.actorDomain !== actor.domain ||
        preview.actorId !== authority.id ||
        preview.requestId !== request.requestId ||
        preview.mode !== mode
      )
        executionConflict("request_conflict");
      if (
        row.revision !== request.expectedRevision ||
        preview.expectedRevision !== row.revision ||
        !["prepared", "draining", "ready"].includes(row.state)
      )
        executionConflict();
      const now = new Date();
      if (now >= preview.expiresAt) executionConflict();
      const facts = await readReplacementExecutionFacts(
        tx,
        row,
        mode,
        this.entitlements,
        now,
        preview.expiresAt,
      );
      if (facts.digest !== preview.factsFingerprint) executionConflict();
      const before = await replacementPreparationProjection(tx, row);
      const serverFacts = { ...facts.serverFacts, actorRole: authority.role };
      if (Buffer.byteLength(JSON.stringify(serverFacts)) > 240_000)
        executionConflict("facts_too_large");
      const newWorkAllowedAt = new Date(
        Math.max(preview.newWorkAllowedAt.getTime(), facts.boundary.getTime()),
      );
      await tx.insert(executions).values({
        tenantId,
        deviceId: row.deviceId,
        preparationId,
        actorDomain: actor.domain,
        actorId: authority.id,
        requestId: request.requestId,
        requestHash: hash,
        mode,
        sourceCredentialEpoch: facts.device.credentialEpoch,
        sourceApiKeyId: facts.device.apiKeyId,
        factsFingerprint: facts.digest,
        readinessReportId:
          facts.report?.credentialEpoch === facts.device.credentialEpoch ? facts.report.id : null,
        emergencyReason: preview.emergencyReason,
        serverFacts,
        offlineAuthorityUntil: newWorkAllowedAt,
        newWorkAllowedAt,
        startedAt: now,
        recoveryState: mode === "normal" ? "not_required" : "required",
      });
      const [next] = await tx
        .update(preparations)
        .set({ state: "executing", revision: row.revision + 1 })
        .where(and(eq(preparations.tenantId, tenantId), eq(preparations.id, preparationId)))
        .returning();
      if (!next) throw new Error("Execution intent update failed");
      // Separate immutable request identity for the started event; the user's
      // request identity belongs to the final transferred receipt.
      const startedRequestId = randomUUID();
      const receipt = {
        requestId: startedRequestId,
        preparation: await replacementPreparationProjection(tx, next),
      };
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: row.deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_execution_started",
        requestId: startedRequestId,
        requestHash: hash,
        before,
        after: receipt.preparation,
        response: receipt,
      });
      await this.recordAudit(
        tx,
        {
          tenantId,
          deviceId: row.deviceId,
          preparationId,
          actorDomain: actor.domain,
          actorId: authority.id,
          serverFacts,
          emergencyReason: preview.emergencyReason,
        },
        "started",
        startedRequestId,
        before,
        receipt.preparation,
      );
      // Prevent any pre-existing code from rotating the frozen source credential.
      await tx
        .update(schema.stationPairingCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.stationPairingCodes.tenantId, tenantId),
            eq(schema.stationPairingCodes.stationDeviceId, row.deviceId),
            isNull(schema.stationPairingCodes.usedAt),
          ),
        );
    });
    return this.repairExecution(tenantId, preparationId);
  }
  /** Preserve the execution lock order while rescheduling one observed failed pass. */
  async deferRepair(row: Pick<Execution, "id" | "tenantId" | "repairAttempts" | "lastRepairAt">) {
    return this.transaction(row.tenantId, async (tx) => {
      const now = new Date();
      const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(row.repairAttempts, 7));
      // Only one replica advances this failure; a completed receipt stays immutable.
      await tx
        .update(executions)
        .set({
          repairAttempts: Math.min(2_147_483_647, row.repairAttempts + 1),
          lastRepairAt: now,
          nextRepairAt: new Date(now.getTime() + delay),
          revision: sql`${executions.revision} + 1`,
        })
        .where(
          and(
            eq(executions.tenantId, row.tenantId),
            eq(executions.id, row.id),
            eq(executions.state, "executing"),
            eq(executions.repairAttempts, row.repairAttempts),
            row.lastRepairAt
              ? eq(executions.lastRepairAt, row.lastRepairAt)
              : isNull(executions.lastRepairAt),
          ),
        );
    });
  }
  /** Continue only the durable, already-authorized cutover; never allocate a new intent. */
  async repairExecution(tenantId: string, preparationId: string) {
    validateId(preparationId);
    const [initial] = await this.db
      .select()
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.preparationId, preparationId)));
    if (!initial) throw new NotFoundException();
    if (initial.response) return deviceReplacementReceiptSchema.parse(initial.response);
    if (initial.step === "revoke_pending") {
      // Auto-commit deletion precedes all business mutations. A failed/lost
      // response is recoverable by repeating this exact persisted key identifier.
      if (initial.sourceApiKeyId)
        await this.db.delete(schema.apikey).where(eq(schema.apikey.id, initial.sourceApiKeyId));
      await this.transaction(tenantId, async (tx) => {
        const current = await this.execution(tx, tenantId, preparationId);
        if (!current || current.step !== "revoke_pending") return;
        await this.requireRevoked(tx, current);
        await tx
          .update(executions)
          .set({
            step: "credential_revoked",
            credentialRevokedAt: new Date(),
            revision: current.revision + 1,
          })
          .where(eq(executions.id, current.id));
      });
    }
    return this.transaction(tenantId, async (tx) => {
      const row = await this.preparation(tx, tenantId, preparationId);
      const current = await this.execution(tx, tenantId, preparationId);
      if (!current) throw new NotFoundException();
      if (current.response) return deviceReplacementReceiptSchema.parse(current.response);
      if (current.step !== "credential_revoked" || row.state !== "executing")
        executionConflict("execution_incomplete");
      await this.requireRevoked(tx, current);
      const target = deviceReplacementObservationSchema.parse(row.observation).target;
      const facts = await readDeviceReplacementFacts(
        tx,
        tenantId,
        row.deviceId,
        target,
        this.entitlements,
      );
      if (
        facts.observation.execution.reasons.some(
          (r) => r === "capacity_unavailable" || r === "handheld_unavailable",
        )
      )
        executionConflict("capacity_unavailable");
      // A late accepted sync/quarantine fact is never hidden by the frozen ready
      // snapshot. Repair stays pending until recovery resolves that work.
      if (
        current.mode === "normal" &&
        deviceReplacementServerWorkBlockers(facts.work, row.deviceId).length
      )
        executionConflict("not_ready");
      const before = await replacementPreparationProjection(tx, row);
      const now = new Date();
      const [source] = await tx
        .update(schema.stationDevices)
        .set({ apiKeyId: null, revokedAt: now })
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            eq(schema.stationDevices.id, row.deviceId),
          ),
        )
        .returning();
      if (!source) throw new Error("Replacement source missing");
      await transitionWorkingAssignment(
        tx,
        source,
        { domain: current.actorDomain, id: current.actorId },
        "released",
        "replacement_transferred",
      );
      const validated = createStationDeviceSchema.parse({ ...target, lineId: source.lineId });
      const [created] = await tx
        .insert(schema.stationDevices)
        .values({ tenantId, ...validated, apiKeyId: null })
        .returning();
      if (!created) throw new Error("Replacement target insert failed");
      await transitionWorkingAssignment(
        tx,
        created,
        { domain: current.actorDomain, id: current.actorId },
        "reserved",
      );
      await tx
        .update(schema.workingDeviceReplacementReadinessIntents)
        .set({ state: "completed", closedAt: now })
        .where(
          and(
            eq(schema.workingDeviceReplacementReadinessIntents.tenantId, tenantId),
            eq(schema.workingDeviceReplacementReadinessIntents.preparationId, preparationId),
            eq(schema.workingDeviceReplacementReadinessIntents.state, "active"),
          ),
        );
      const [completed] = await tx
        .update(preparations)
        .set({ state: "completed", revision: row.revision + 1 })
        .where(and(eq(preparations.tenantId, tenantId), eq(preparations.id, preparationId)))
        .returning();
      if (!completed) throw new Error("Replacement preparation completion failed");
      // Construct the receipt before the single final aggregate update: the DB
      // requires target, timestamps and immutable response to commit together.
      const projection = {
        ...before,
        state: "completed",
        revision: completed.revision,
        execution: {
          id: current.id,
          revision: current.revision + 1,
          step: "transferred",
          mode: current.mode,
          targetDeviceId: created.id,
          executedAt: now.toISOString(),
          newWorkAllowedAt: current.newWorkAllowedAt.toISOString(),
          recoveryState: current.recoveryState,
        },
      };
      const receipt = deviceReplacementReceiptSchema.parse({
        requestId: current.requestId,
        preparation: projection,
      });
      await tx
        .update(executions)
        .set({
          state: "completed",
          step: "transferred",
          revision: current.revision + 1,
          targetDeviceId: created.id,
          executedAt: now,
          response: receipt,
        })
        .where(eq(executions.id, current.id));
      await tx
        .update(schema.entitlementRevisions)
        .set({ revision: sql`${schema.entitlementRevisions.revision} + 1` })
        .where(eq(schema.entitlementRevisions.tenantId, tenantId));
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: row.deviceId,
        actorDomain: current.actorDomain,
        actorId: current.actorId,
        action: "replacement_transferred",
        requestId: current.requestId,
        requestHash: current.requestHash,
        before,
        after: receipt.preparation,
        response: receipt,
      });
      await this.recordAudit(
        tx,
        current,
        "transferred",
        current.requestId,
        before,
        receipt.preparation,
      );
      return receipt;
    });
  }
  private async requireRevoked(tx: SubscriptionTransaction, execution: Execution) {
    const [device] = await tx
      .select()
      .from(schema.stationDevices)
      .where(
        and(
          eq(schema.stationDevices.tenantId, execution.tenantId),
          eq(schema.stationDevices.id, execution.deviceId),
        ),
      );
    if (
      !device ||
      device.apiKeyId !== execution.sourceApiKeyId ||
      device.credentialEpoch !== execution.sourceCredentialEpoch
    )
      executionConflict("credential_changed");
    if (execution.sourceApiKeyId) {
      const [key] = await tx
        .select({ id: schema.apikey.id })
        .from(schema.apikey)
        .where(eq(schema.apikey.id, execution.sourceApiKeyId));
      if (key) executionConflict("credential_revoke_unconfirmed");
    }
  }
  private async preparation(tx: SubscriptionTransaction, tenantId: string, preparationId: string) {
    const [row] = await tx
      .select()
      .from(preparations)
      .where(and(eq(preparations.tenantId, tenantId), eq(preparations.id, preparationId)))
      .for("update");
    if (!row) throw new NotFoundException();
    return row;
  }
  private async execution(tx: SubscriptionTransaction, tenantId: string, preparationId: string) {
    return (
      await tx
        .select()
        .from(executions)
        .where(and(eq(executions.tenantId, tenantId), eq(executions.preparationId, preparationId)))
        .for("update")
    )[0];
  }
  private async requireUnusedRequest(
    tx: SubscriptionTransaction,
    tenantId: string,
    requestId: string,
  ) {
    const [event] = await tx
      .select({ id: schema.workingDeviceEvents.id })
      .from(schema.workingDeviceEvents)
      .where(
        and(
          eq(schema.workingDeviceEvents.tenantId, tenantId),
          eq(schema.workingDeviceEvents.requestId, requestId),
        ),
      );
    const [preparationPreview] = await tx
      .select({ id: schema.workingDeviceReplacementPreviews.id })
      .from(schema.workingDeviceReplacementPreviews)
      .where(
        and(
          eq(schema.workingDeviceReplacementPreviews.tenantId, tenantId),
          eq(schema.workingDeviceReplacementPreviews.requestId, requestId),
        ),
      );
    const [execution] = await tx
      .select({ id: executions.id })
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.requestId, requestId)));
    if (event || preparationPreview || execution) executionConflict("request_conflict");
  }
  private async recordAudit(
    tx: SubscriptionTransaction,
    execution: Pick<
      Execution,
      | "tenantId"
      | "deviceId"
      | "preparationId"
      | "actorDomain"
      | "actorId"
      | "serverFacts"
      | "emergencyReason"
    >,
    operation: "started" | "transferred",
    requestId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    if (execution.actorDomain === "platform") {
      const role = execution.serverFacts.actorRole;
      if (role !== "platform_admin" && role !== "support" && role !== "accountant")
        throw new Error("Execution actor role missing");
      await this.audit.record(tx, {
        actorPlatformUserId: execution.actorId,
        actorRole: role,
        tenantId: execution.tenantId,
        action: `device.replacement.${operation}`,
        outcome: "success",
        targetType: "device_replacement",
        targetId: execution.preparationId,
        requestId,
        reason: execution.emergencyReason,
        before,
        after,
      });
    } else
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: execution.tenantId,
        actorUserId: execution.actorId,
        action: `device.replacement.${operation}`,
        outcome: "success",
        targetType: "device_replacement",
        targetId: execution.preparationId,
        requestId,
        before,
        after,
      });
  }
}
