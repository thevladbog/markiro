import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, asc, eq } from "drizzle-orm";
import {
  deviceReplacementCancelSchema,
  deviceReplacementConfirmSchema,
  deviceReplacementListSchema,
  deviceReplacementObservationSchema,
  deviceReplacementPreparationSchema,
  deviceReplacementPreviewRequestSchema,
  deviceReplacementPreviewSchema,
  deviceReplacementReceiptSchema,
  platformUuidSchema,
  type DeviceReplacementCancel,
  type DeviceReplacementConfirm,
  type DeviceReplacementList,
  type DeviceReplacementPreviewRequest,
  type DeviceReplacementPreview,
  type DeviceReplacementReceipt,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import {
  QUANTITATIVE_ENTITLEMENT_KEYS,
  type SubscriptionTransaction,
} from "../../subscriptions/entitlements.types";
import { lockTenantSubscriptionTimeline } from "../../subscriptions/subscription-locks";
import {
  requireDeviceLicensingActor,
  type DeviceLicensingActor,
} from "./device-licensing-authority";
import {
  createDeviceReplacementListFactReader,
  readDeviceReplacementFacts,
  replacementDigest,
} from "./device-replacement-facts";

type Preparation = typeof schema.workingDeviceReplacementPreparations.$inferSelect;
type Preview = typeof schema.workingDeviceReplacementPreviews.$inferSelect;
function publicPreparation(row: Preparation) {
  return deviceReplacementPreparationSchema.parse({
    id: row.id,
    sourceDeviceId: row.deviceId,
    revision: row.revision,
    state: row.state,
    preparedAt: row.preparedAt.toISOString(),
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    observation: row.observation,
  });
}
function publicPreview(row: Preview) {
  return deviceReplacementPreviewSchema.parse({
    id: row.id,
    requestId: row.requestId,
    sourceDeviceId: row.deviceId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    observation: row.observation,
  });
}
function conflict(code: string): never {
  throw new ConflictException({ code: `device_replacement_${code}` });
}
function validateId(id: string) {
  if (!platformUuidSchema.safeParse(id).success)
    throw new BadRequestException({ code: "device_replacement_invalid" });
}

@Injectable()
export class DeviceReplacementService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}
  async list(tenantId: string, actor: DeviceLicensingActor): Promise<DeviceReplacementList> {
    return this.db.transaction(
      async (tx) => {
        const authority = await requireDeviceLicensingActor(tx, tenantId, actor, false);
        const rows = await tx
          .select()
          .from(schema.workingDeviceReplacementPreparations)
          .where(eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId))
          .orderBy(
            asc(schema.workingDeviceReplacementPreparations.preparedAt),
            asc(schema.workingDeviceReplacementPreparations.id),
          );
        const readFacts = createDeviceReplacementListFactReader(tx, tenantId, this.entitlements);
        const items = [];
        for (const row of rows) {
          let needsReview = false;
          if (row.state === "prepared") {
            try {
              const facts = await readFacts(
                row.deviceId,
                deviceReplacementObservationSchema.parse(row.observation).target,
              );
              needsReview = facts.fingerprint !== row.factsFingerprint;
            } catch (error) {
              if (error instanceof ConflictException || error instanceof NotFoundException)
                needsReview = true;
              else throw error;
            }
          }
          items.push({ preparation: publicPreparation(row), needsReview });
        }
        return deviceReplacementListSchema.parse({ canPrepare: authority.canCancel, items });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  async preview(
    tenantId: string,
    deviceId: string,
    input: DeviceReplacementPreviewRequest,
    actor: DeviceLicensingActor,
  ): Promise<DeviceReplacementPreview> {
    validateId(deviceId);
    const parsed = deviceReplacementPreviewRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_replacement_invalid" });
    const request = parsed.data;
    const hash = replacementDigest({ deviceId, ...request });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const [existing] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreviews)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreviews.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreviews.requestId, request.requestId),
          ),
        );
      if (
        existing &&
        (existing.actorDomain !== actor.domain ||
          existing.actorId !== authority.id ||
          existing.deviceId !== deviceId ||
          existing.payloadHash !== hash)
      )
        conflict("request_conflict");
      const event = await this.event(tx, tenantId, request.requestId);
      if (
        event &&
        (!existing ||
          event.action !== "replacement_prepared" ||
          event.actorDomain !== actor.domain ||
          event.actorId !== authority.id)
      )
        conflict("request_conflict");
      const facts = await readDeviceReplacementFacts(
        tx,
        tenantId,
        deviceId,
        request.target,
        this.entitlements,
      );
      const now = new Date();
      if (existing) {
        if (now >= existing.expiresAt || existing.factsFingerprint !== facts.fingerprint)
          conflict("stale");
        return publicPreview(existing);
      }
      await this.requireNoCurrent(tx, tenantId, deviceId);
      const expiresAt = new Date(
        Math.min(
          now.getTime() + 5 * 60 * 1000,
          facts.nextChangeAt ? Date.parse(facts.nextChangeAt) : Infinity,
        ),
      );
      if (expiresAt <= now) conflict("stale");
      const [row] = await tx
        .insert(schema.workingDeviceReplacementPreviews)
        .values({
          tenantId,
          deviceId,
          actorDomain: actor.domain,
          actorId: authority.id,
          requestId: request.requestId,
          payload: request,
          payloadHash: hash,
          factsFingerprint: facts.fingerprint,
          observation: facts.observation,
          createdAt: now,
          expiresAt,
        })
        .returning();
      if (!row) throw new Error("Replacement preview insert failed");
      return publicPreview(row);
    });
  }
  async confirm(
    tenantId: string,
    deviceId: string,
    input: DeviceReplacementConfirm,
    actor: DeviceLicensingActor,
  ): Promise<DeviceReplacementReceipt> {
    validateId(deviceId);
    const parsed = deviceReplacementConfirmSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_replacement_invalid" });
    const request = parsed.data;
    const hash = replacementDigest({ operation: "confirm", deviceId, ...request });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const event = await this.event(tx, tenantId, request.requestId);
      if (event) {
        if (
          event.action !== "replacement_prepared" ||
          event.actorDomain !== actor.domain ||
          event.actorId !== authority.id ||
          event.requestHash !== hash ||
          event.deviceId !== deviceId
        )
          conflict("request_conflict");
        return deviceReplacementReceiptSchema.parse(event.response);
      }
      const [preview] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreviews)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreviews.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreviews.id, request.previewId),
          ),
        );
      if (!preview || preview.deviceId !== deviceId) throw new NotFoundException();
      if (
        preview.actorDomain !== actor.domain ||
        preview.actorId !== authority.id ||
        preview.requestId !== request.requestId
      )
        conflict("request_conflict");
      if (preview.confirmedAt) conflict("request_conflict");
      const intent = deviceReplacementPreviewRequestSchema.parse(preview.payload);
      const facts = await readDeviceReplacementFacts(
        tx,
        tenantId,
        deviceId,
        intent.target,
        this.entitlements,
      );
      const now = new Date();
      if (now >= preview.expiresAt || facts.fingerprint !== preview.factsFingerprint)
        conflict("stale");
      await this.requireNoCurrent(tx, tenantId, deviceId);
      const [row] = await tx
        .insert(schema.workingDeviceReplacementPreparations)
        .values({
          id: randomUUID(),
          tenantId,
          deviceId,
          previewId: preview.id,
          actorDomain: actor.domain,
          actorId: authority.id,
          observation: preview.observation,
          factsFingerprint: preview.factsFingerprint,
          preparedAt: now,
        })
        .returning();
      if (!row) throw new Error("Replacement preparation insert failed");
      const receipt = deviceReplacementReceiptSchema.parse({
        requestId: request.requestId,
        preparation: publicPreparation(row),
      });
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_prepared",
        before: null,
        after: receipt.preparation,
        requestId: request.requestId,
        requestHash: hash,
        response: receipt,
      });
      await tx
        .update(schema.workingDeviceReplacementPreviews)
        .set({ confirmedAt: now, resultPreparationId: row.id, response: receipt })
        .where(eq(schema.workingDeviceReplacementPreviews.id, preview.id));
      if (actor.domain === "platform")
        await this.audit.record(tx, {
          actorPlatformUserId: authority.id,
          actorRole: authority.role,
          tenantId,
          action: "device.replacement.prepared",
          outcome: "success",
          targetType: "station_device",
          targetId: deviceId,
          reason: intent.reason,
          before: null,
          after: receipt.preparation,
          requestId: request.requestId,
        });
      return receipt;
    });
  }
  async cancel(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementCancel,
    actor: DeviceLicensingActor,
  ): Promise<DeviceReplacementReceipt> {
    validateId(preparationId);
    const parsed = deviceReplacementCancelSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_replacement_invalid" });
    const request = parsed.data;
    const hash = replacementDigest({ operation: "cancel", preparationId, ...request });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const event = await this.event(tx, tenantId, request.requestId);
      if (event) {
        if (
          event.action !== "replacement_cancelled" ||
          event.actorDomain !== actor.domain ||
          event.actorId !== authority.id ||
          event.requestHash !== hash
        )
          conflict("request_conflict");
        return deviceReplacementReceiptSchema.parse(event.response);
      }
      const [usedPreview] = await tx
        .select({ id: schema.workingDeviceReplacementPreviews.id })
        .from(schema.workingDeviceReplacementPreviews)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreviews.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreviews.requestId, request.requestId),
          ),
        );
      if (usedPreview) conflict("request_conflict");
      const [row] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreparations)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreparations.id, preparationId),
          ),
        )
        .for("update");
      if (!row) throw new NotFoundException();
      if (row.state !== "prepared" || row.revision !== request.expectedRevision) conflict("stale");
      const before = publicPreparation(row);
      const [next] = await tx
        .update(schema.workingDeviceReplacementPreparations)
        .set({
          state: "cancelled",
          revision: row.revision + 1,
          cancelledAt: new Date(),
          cancelledActorDomain: actor.domain,
          cancelledActorId: authority.id,
        })
        .where(eq(schema.workingDeviceReplacementPreparations.id, preparationId))
        .returning();
      if (!next) throw new Error("Replacement cancellation failed");
      const receipt = deviceReplacementReceiptSchema.parse({
        requestId: request.requestId,
        preparation: publicPreparation(next),
      });
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: row.deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_cancelled",
        before,
        after: receipt.preparation,
        requestId: request.requestId,
        requestHash: hash,
        response: receipt,
      });
      if (actor.domain === "platform")
        await this.audit.record(tx, {
          actorPlatformUserId: authority.id,
          actorRole: authority.role,
          tenantId,
          action: "device.replacement.cancelled",
          outcome: "success",
          targetType: "station_device",
          targetId: row.deviceId,
          reason: null,
          before,
          after: receipt.preparation,
          requestId: request.requestId,
        });
      return receipt;
    });
  }
  private async event(tx: SubscriptionTransaction, tenantId: string, requestId: string) {
    return (
      await tx
        .select()
        .from(schema.workingDeviceEvents)
        .where(
          and(
            eq(schema.workingDeviceEvents.tenantId, tenantId),
            eq(schema.workingDeviceEvents.requestId, requestId),
          ),
        )
    )[0];
  }
  private async requireNoCurrent(tx: SubscriptionTransaction, tenantId: string, deviceId: string) {
    const [row] = await tx
      .select({ id: schema.workingDeviceReplacementPreparations.id })
      .from(schema.workingDeviceReplacementPreparations)
      .where(
        and(
          eq(schema.workingDeviceReplacementPreparations.tenantId, tenantId),
          eq(schema.workingDeviceReplacementPreparations.deviceId, deviceId),
          eq(schema.workingDeviceReplacementPreparations.state, "prepared"),
        ),
      );
    if (row) conflict("already_prepared");
  }
  private async transaction<T>(
    tenantId: string,
    action: (tx: SubscriptionTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++)
      try {
        return await this.db.transaction(
          async (tx) => {
            for (const key of QUANTITATIVE_ENTITLEMENT_KEYS)
              await this.entitlements.withQuotaLock(tx, tenantId, key, () =>
                Promise.resolve(undefined),
              );
            await lockTenantSubscriptionTimeline(tx, tenantId);
            await tx
              .select({ id: schema.tenantSubscriptions.id })
              .from(schema.tenantSubscriptions)
              .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
              .orderBy(asc(schema.tenantSubscriptions.id))
              .for("update");
            await tx
              .select({ id: schema.stationDevices.id })
              .from(schema.stationDevices)
              .where(eq(schema.stationDevices.tenantId, tenantId))
              .orderBy(asc(schema.stationDevices.id))
              .for("update");
            return action(tx);
          },
          // Retention and replacement insertions share quota locks, but do not
          // bump operational revisions. Capture facts after any lock wait.
          { isolationLevel: "read committed" },
        );
      } catch (error) {
        let cursor: unknown = error;
        let retryable = false;
        for (let depth = 0; depth < 5 && cursor && typeof cursor === "object"; depth++) {
          if ("code" in cursor && cursor.code === "40001") retryable = true;
          if (
            "code" in cursor &&
            cursor.code === "23505" &&
            "constraint" in cursor &&
            [
              "working_device_replacement_previews_tenant_request_uq",
              "working_device_replacements_one_prepared_uq",
              "working_device_events_tenant_request_uq",
              "working_device_replacement_preparations_tenant_preview_uq",
            ].includes(String(cursor.constraint))
          )
            retryable = true;
          cursor = "cause" in cursor ? cursor.cause : null;
        }
        if (!retryable || attempt >= 2) throw error;
      }
  }
}
