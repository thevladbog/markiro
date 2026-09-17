import { recoveryKeyMetadata } from "./replacement-recovery-policy";
import {
  deviceReplacementReadinessRequestSchema,
  deviceReplacementReadinessResponseSchema,
  type DeviceReplacementReadinessRequest,
} from "@markiro/platform-contracts";
import {
  lockCurrentGrantOwner,
  type GrantCredentialIdentity,
} from "../device-grants/credential-epoch";
import { readDeviceLicensingWork } from "./device-licensing-work";
import { deviceReplacementServerWorkBlockers } from "./device-replacement-readiness-work";
import { replacementStorageRevisionHighWater } from "./device-replacement-readiness-projection";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, eq, isNull, desc } from "drizzle-orm";
import {
  deviceReplacementRecoveryCodeRequestSchema,
  deviceReplacementRecoveryCloseRequestSchema,
  deviceReplacementRecoveryCodeResponseSchema,
  deviceReplacementReceiptSchema,
  platformUuidSchema,
  type DeviceReplacementRecoveryCodeRequest,
  type DeviceReplacementRecoveryCloseRequest,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { lockGrantFacts } from "../device-grants/grant-admission";
import {
  requireDeviceLicensingActor,
  type DeviceLicensingActor,
} from "./device-licensing-authority";
import { replacementDigest } from "./device-replacement-facts";
import { replacementPreparationProjection } from "./device-replacement-readiness-projection";
import { hashPairingCode } from "../../pickup/device-token";
import { loadEnv } from "../../env";
import { mintPairingCode, PAIRING_TTL_MS } from "../device-pairing/pairing-policy";

const executions = schema.workingDeviceReplacementExecutions;
export const recoveryConflict = () =>
  new ConflictException({ code: "device_replacement_recovery_conflict" });

@Injectable()
export class DeviceReplacementRecoveryService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}
  private transaction<T>(tenantId: string, action: (tx: SubscriptionTransaction) => Promise<T>) {
    return this.db.transaction(async (tx) => {
      await lockGrantFacts(tx, tenantId, this.entitlements);
      return action(tx);
    });
  }
  async issueReplacementRecoveryCode(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementRecoveryCodeRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementRecoveryCodeRequestSchema.safeParse(input);
    if (!parsed.success || !platformUuidSchema.safeParse(preparationId).success)
      throw new BadRequestException();
    const body = parsed.data;
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const execution = await this.current(tx, tenantId, preparationId);
      if (execution.revision !== body.expectedRevision) throw recoveryConflict();
      await this.unused(tx, tenantId, body.requestId);
      const [preparation] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(eq(schema.workingDeviceReplacementPreparations.id, preparationId));
      if (!preparation) throw new NotFoundException();
      const [source] = await tx
        .select()
        .from(schema.stationDevices)
        .where(
          and(
            eq(schema.stationDevices.tenantId, tenantId),
            eq(schema.stationDevices.id, execution.deviceId),
          ),
        )
        .for("update");
      if (!source?.revokedAt) throw recoveryConflict();
      const before = await replacementPreparationProjection(tx, preparation);
      const now = new Date(),
        expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
      await tx
        .update(schema.stationPairingCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(schema.stationPairingCodes.tenantId, tenantId),
            eq(schema.stationPairingCodes.stationDeviceId, execution.deviceId),
            isNull(schema.stationPairingCodes.usedAt),
          ),
        );
      let secret: { code: string; id: string } | undefined;
      for (let n = 0; n < 5; n++) {
        const code = mintPairingCode();
        const [saved] = await tx
          .insert(schema.stationPairingCodes)
          .values({
            tenantId,
            stationDeviceId: execution.deviceId,
            purpose: "replacement_recovery",
            codeHash: hashPairingCode(code, loadEnv().PAIRING_CODE_PEPPER),
            expiresAt,
            issuedByUserId: authority.id,
          })
          .onConflictDoNothing()
          .returning({ id: schema.stationPairingCodes.id });
        if (saved) {
          secret = { code, id: saved.id };
          break;
        }
      }
      if (!secret) throw new Error("Could not mint recovery code");
      await tx
        .update(executions)
        .set({ revision: execution.revision + 1 })
        .where(eq(executions.id, execution.id));
      const projection = await replacementPreparationProjection(tx, preparation);
      const receipt = { requestId: body.requestId, preparation: projection };
      const after = {
        ...projection,
        executionId: execution.id,
        pairingCodeId: secret.id,
        sourceCredentialEpoch: source.credentialEpoch,
        operation: "issue_recovery_code",
      };
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: execution.deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_recovery_started",
        requestId: body.requestId,
        requestHash: replacementDigest({
          operation: "issue_recovery_code",
          preparationId,
          ...body,
        }),
        before,
        after,
        response: receipt,
      });
      await this.recordAudit(
        tx,
        tenantId,
        preparationId,
        actor,
        authority,
        body.requestId,
        "recovery_code_issued",
        before,
        after,
      );
      return deviceReplacementRecoveryCodeResponseSchema.parse({
        ...receipt,
        code: secret.code,
        expiresAt: expiresAt.toISOString(),
      });
    });
  }
  async closeReplacementRecovery(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementRecoveryCloseRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementRecoveryCloseRequestSchema.safeParse(input);
    if (!parsed.success || !platformUuidSchema.safeParse(preparationId).success)
      throw new BadRequestException();
    const body = parsed.data,
      hash = replacementDigest({ operation: "close_recovery", preparationId, ...body });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const [prior] = await tx
        .select()
        .from(schema.workingDeviceEvents)
        .where(
          and(
            eq(schema.workingDeviceEvents.tenantId, tenantId),
            eq(schema.workingDeviceEvents.requestId, body.requestId),
          ),
        );
      if (prior) {
        if (
          prior.action !== "replacement_recovery_unavailable" ||
          prior.actorDomain !== actor.domain ||
          prior.actorId !== authority.id ||
          prior.requestHash !== hash
        )
          throw recoveryConflict();
        return deviceReplacementReceiptSchema.parse(prior.response);
      }
      const execution = await this.current(tx, tenantId, preparationId);
      if (execution.revision !== body.expectedRevision) throw recoveryConflict();
      await this.unused(tx, tenantId, body.requestId);
      const [preparation] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(eq(schema.workingDeviceReplacementPreparations.id, preparationId));
      if (!preparation) throw new NotFoundException();
      const before = await replacementPreparationProjection(tx, preparation),
        now = new Date();
      await revokeReplacementRecovery(tx, execution);
      await tx
        .update(executions)
        .set({
          revision: execution.revision + 1,
          recoveryState: "evidence_unavailable",
          recoveryClosedAt: now,
          recoveryCloseReason: body.reason,
        })
        .where(eq(executions.id, execution.id));
      const projection = await replacementPreparationProjection(tx, preparation);
      const response = deviceReplacementReceiptSchema.parse({
        requestId: body.requestId,
        preparation: projection,
      });
      const after = {
        ...projection,
        executionId: execution.id,
        reason: body.reason,
        recoveryState: "evidence_unavailable",
      };
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: execution.deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_recovery_unavailable",
        requestId: body.requestId,
        requestHash: hash,
        before,
        after,
        response,
      });
      await this.recordAudit(
        tx,
        tenantId,
        preparationId,
        actor,
        authority,
        body.requestId,
        "recovery_closed",
        before,
        after,
      );
      return response;
    });
  }
  async report(
    identity: GrantCredentialIdentity,
    executionId: string,
    input: DeviceReplacementReadinessRequest,
  ) {
    const parsed = deviceReplacementReadinessRequestSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 240_000)
      throw new BadRequestException();
    const body = parsed.data,
      hash = replacementDigest(body);
    return this.transaction(identity.tenantId, async (tx) => {
      const now = new Date();
      const owner = await lockCurrentGrantOwner(tx, identity, now.getTime(), true);
      if (!owner || owner.kind === "kiosk" || owner.credentialEpoch !== body.credentialEpoch)
        throw new UnauthorizedException();
      const [execution] = await tx
        .select()
        .from(executions)
        .where(
          and(
            eq(executions.tenantId, owner.tenantId),
            eq(executions.deviceId, owner.deviceId),
            eq(executions.id, executionId),
          ),
        )
        .for("update");
      if (
        !execution ||
        execution.recoveryState !== "draining" ||
        execution.recoveryCredentialEpoch !== owner.credentialEpoch
      )
        throw new UnauthorizedException();
      const reports = schema.workingDeviceReplacementReadinessReports,
        intents = schema.workingDeviceReplacementReadinessIntents;
      const [prior] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.tenantId, owner.tenantId), eq(reports.requestId, body.requestId)));
      if (prior) {
        if (
          prior.deviceId !== owner.deviceId ||
          prior.credentialEpoch !== owner.credentialEpoch ||
          prior.payloadHash !== hash
        )
          throw recoveryConflict();
        return deviceReplacementReadinessResponseSchema.parse(prior.response);
      }
      await this.unused(tx, owner.tenantId, body.requestId);
      const [intent] = await tx
        .select()
        .from(intents)
        .where(
          and(
            eq(intents.tenantId, owner.tenantId),
            eq(intents.deviceId, owner.deviceId),
            eq(intents.preparationId, execution.preparationId),
            eq(intents.id, body.intentId),
            eq(intents.credentialEpoch, owner.credentialEpoch),
          ),
        );
      if (!intent) throw new UnauthorizedException();
      const [latest] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.tenantId, owner.tenantId), eq(reports.intentId, intent.id)))
        .orderBy(desc(reports.reportSequence))
        .limit(1);
      if (
        (
          await tx
            .select({ id: reports.id })
            .from(reports)
            .where(
              and(
                eq(reports.tenantId, owner.tenantId),
                eq(reports.intentId, intent.id),
                eq(reports.reportSequence, body.reportSequence),
              ),
            )
        )[0]
      )
        throw recoveryConflict();
      const [preparation] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(eq(schema.workingDeviceReplacementPreparations.id, execution.preparationId));
      if (!preparation) throw new NotFoundException();
      const work = await readDeviceLicensingWork(tx, owner.tenantId);
      const counters = {
        ...body.pending,
        conflicts: body.conflicts,
        unknownPrints: body.unknownPrints,
      };
      const channels = [
        "scans",
        "inventories",
        "shiftClosures",
        "productLabels",
        "boxes",
        "exceptions",
        "conflicts",
        "unknownPrints",
      ] as const;
      const pendingReasons = [
        "pending_scans",
        "pending_inventories",
        "pending_shift_closures",
        "pending_product_labels",
        "pending_boxes",
        "pending_exceptions",
        "conflicts",
        "unknown_prints",
      ] as const;
      const reasons: string[] = [];
      if (
        intent.state !== "active" ||
        now >= intent.expiresAt ||
        body.storageRevision < (await replacementStorageRevisionHighWater(tx, intent)) ||
        (latest && body.reportSequence < latest.reportSequence)
      )
        reasons.push("report_stale");
      const unsupportedChannels = channels.filter((c) => counters[c] === "unsupported");
      if (unsupportedChannels.length) reasons.push("client_upgrade_required");
      channels.forEach((c, i) => {
        const v = counters[c];
        if (typeof v === "number" && v > 0) reasons.push(pendingReasons[i]!);
      });
      if (body.activeTasks.length) reasons.push("active_tasks");
      const issued = await tx
        .select()
        .from(schema.deviceGrantIssuances)
        .where(
          and(
            eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
            eq(schema.deviceGrantIssuances.stationDeviceId, owner.deviceId),
            eq(schema.deviceGrantIssuances.ownerKind, owner.kind),
          ),
        );
      if (
        body.installedGrants.some(({ grantId }) => {
          const grant = issued.find((g) => g.grantId === grantId);
          return (
            !grant ||
            (grant.kindOfGrant === "device" && (!grant.startNotAfter || grant.startNotAfter > now))
          );
        })
      )
        reasons.push("installed_grants");
      reasons.push(...deviceReplacementServerWorkBlockers(work, owner.deviceId));
      const response = deviceReplacementReadinessResponseSchema.parse({
        requestId: body.requestId,
        intentId: intent.id,
        receivedAt: now.toISOString(),
        unsupportedChannels,
        eligibility: {
          status: reasons.length ? "blocked" : "eligible",
          reasons: [...new Set(reasons)],
        },
      });
      const [report] = await tx
        .insert(reports)
        .values({
          tenantId: owner.tenantId,
          deviceId: owner.deviceId,
          preparationId: execution.preparationId,
          intentId: intent.id,
          requestId: body.requestId,
          credentialEpoch: owner.credentialEpoch,
          reportSequence: body.reportSequence,
          clientBuild: body.clientBuild,
          storageRevision: body.storageRevision,
          payload: body,
          payloadHash: hash,
          counters,
          eligibility: response.eligibility,
          response,
          receivedAt: now,
        })
        .returning();
      if (!report) throw new Error("Recovery report insert failed");
      const before = await replacementPreparationProjection(tx, preparation);
      if (response.eligibility.status === "eligible") {
        await revokeReplacementRecovery(tx, execution);
        await tx
          .update(executions)
          .set({
            revision: execution.revision + 1,
            recoveryState: "completed",
            recoveryClosedAt: now,
          })
          .where(eq(executions.id, execution.id));
        await tx
          .update(intents)
          .set({ state: "completed", closedAt: now })
          .where(eq(intents.id, intent.id));
        const after = await replacementPreparationProjection(tx, preparation);
        await tx.insert(schema.workingDeviceEvents).values({
          tenantId: owner.tenantId,
          deviceId: owner.deviceId,
          actorDomain: "device",
          actorId: owner.deviceId,
          action: "replacement_recovery_completed",
          requestId: body.requestId,
          requestHash: hash,
          before,
          after,
          response: { requestId: body.requestId, preparation: after },
        });
      }
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: owner.tenantId,
        actorUserId: null,
        action:
          response.eligibility.status === "eligible"
            ? "device.replacement.recovery_completed"
            : "device.replacement.recovery_reported",
        outcome: "success",
        targetType: "device_replacement",
        targetId: execution.preparationId,
        requestId: body.requestId,
        after: {
          actorDomain: "station_device",
          actorId: owner.deviceId,
          deviceKind: owner.kind,
          credentialEpoch: owner.credentialEpoch,
          executionId,
          intentId: intent.id,
          reportId: report.id,
          eligibility: response.eligibility,
        },
      });
      return response;
    });
  }
  private async current(tx: SubscriptionTransaction, tenantId: string, preparationId: string) {
    const [execution] = await tx
      .select()
      .from(executions)
      .where(and(eq(executions.tenantId, tenantId), eq(executions.preparationId, preparationId)))
      .for("update");
    if (!execution) throw new NotFoundException();
    if (
      execution.state !== "completed" ||
      execution.mode !== "emergency" ||
      !["required", "draining"].includes(execution.recoveryState)
    )
      throw recoveryConflict();
    return execution;
  }
  private async unused(tx: SubscriptionTransaction, tenantId: string, requestId: string) {
    for (const table of [
      schema.workingDeviceEvents,
      schema.workingDeviceReplacementReadinessReports,
      schema.workingDeviceReplacementPreviews,
      schema.workingDeviceReplacementExecutionPreviews,
      schema.workingDeviceReplacementClosureAcknowledgements,
    ]) {
      if (
        (
          await tx
            .select({ id: table.id })
            .from(table)
            .where(and(eq(table.tenantId, tenantId), eq(table.requestId, requestId)))
        )[0]
      )
        throw recoveryConflict();
    }
  }
  private async recordAudit(
    tx: SubscriptionTransaction,
    tenantId: string,
    preparationId: string,
    actor: DeviceLicensingActor,
    authority: Awaited<ReturnType<typeof requireDeviceLicensingActor>>,
    requestId: string,
    operation: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
  ) {
    if (actor.domain === "platform") {
      if (!authority.role) throw new Error("Missing platform role");
      await this.audit.record(tx, {
        actorPlatformUserId: authority.id,
        actorRole: authority.role,
        tenantId,
        action: `device.replacement.${operation}`,
        outcome: "success",
        targetType: "device_replacement",
        targetId: preparationId,
        requestId,
        reason: typeof after.reason === "string" ? after.reason : null,
        before,
        after,
      });
    } else
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: tenantId,
        actorUserId: authority.id,
        action: `device.replacement.${operation}`,
        outcome: "success",
        targetType: "device_replacement",
        targetId: preparationId,
        requestId,
        before,
        after,
      });
  }
}
export async function revokeReplacementRecovery(
  tx: SubscriptionTransaction,
  execution: typeof executions.$inferSelect,
) {
  const [source] = await tx
    .select()
    .from(schema.stationDevices)
    .where(
      and(
        eq(schema.stationDevices.tenantId, execution.tenantId),
        eq(schema.stationDevices.id, execution.deviceId),
      ),
    )
    .for("update");
  if (source?.apiKeyId) {
    const [key] = await tx
      .select()
      .from(schema.apikey)
      .where(eq(schema.apikey.id, source.apiKeyId));
    const binding = recoveryKeyMetadata(key?.metadata);
    if (
      key &&
      (!binding ||
        binding.executionId !== execution.id ||
        binding.deviceId !== execution.deviceId ||
        !source.revokedAt)
    )
      throw recoveryConflict();
    await tx.delete(schema.apikey).where(eq(schema.apikey.id, source.apiKeyId));
    await tx
      .update(schema.stationDevices)
      .set({ apiKeyId: null })
      .where(eq(schema.stationDevices.id, source.id));
  }
  await tx
    .update(schema.stationPairingCodes)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.stationPairingCodes.tenantId, execution.tenantId),
        eq(schema.stationPairingCodes.stationDeviceId, execution.deviceId),
        isNull(schema.stationPairingCodes.usedAt),
      ),
    );
}
