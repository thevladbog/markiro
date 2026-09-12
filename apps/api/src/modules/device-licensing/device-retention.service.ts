import { lockDeviceLicensingFacts } from "./device-licensing-fact-locks";
import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { CABINET_CAPABILITY, hasCabinetCapabilities, resolveCabinetAccess } from "@markiro/domain";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  deviceRetentionConfirmSchema,
  deviceRetentionInspectionSchema,
  deviceRetentionPreviewRequestSchema,
  deviceRetentionPreviewSchema,
  deviceRetentionReceiptSchema,
  deviceRetentionSelectionSchema,
  type DeviceRetentionConfirm,
  type DeviceRetentionInspection,
  type DeviceRetentionPreview,
  type DeviceRetentionPreviewRequest,
  type DeviceRetentionReceipt,
  type DeviceRetentionSelection,
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
import { replacementDigest } from "./device-replacement-facts";
import { readDeviceRetentionFacts, retentionConditions } from "./device-retention-facts";

type Preview = typeof schema.workingDeviceRetentionPreviews.$inferSelect;
const envelopeSchema = z
  .object({
    request: deviceRetentionPreviewRequestSchema,
    freshnessFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
function conflict(code: string): never {
  throw new ConflictException({ code: `device_retention_${code}` });
}
function auditSelection(selection: DeviceRetentionSelection | undefined) {
  return selection
    ? {
        id: selection.id,
        revision: selection.revision,
        preparedAt: selection.preparedAt,
        selectedDeviceCount: selection.selectedDeviceIds.length,
        selectedDeviceIdsDigest: replacementDigest(selection.selectedDeviceIds),
        boundary: selection.observation.boundary,
      }
    : null;
}
function publicPreview(row: Preview) {
  return deviceRetentionPreviewSchema.parse({
    id: row.id,
    requestId: row.requestId,
    expectedRevision: row.expectedRevision,
    selectedDeviceIds: row.selectedDeviceIds,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    observation: row.observation,
  });
}

@Injectable()
export class DeviceRetentionService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    private readonly audit: PlatformAuditService,
  ) {}
  private async authority(
    tx: SubscriptionTransaction,
    tenantId: string,
    actor: DeviceLicensingActor,
    write: boolean,
  ) {
    const authority = await requireDeviceLicensingActor(tx, tenantId, actor, write);
    if (actor.domain !== "cabinet") return { ...authority, canSelect: authority.canCancel };
    const query = tx
      .select({ role: schema.member.role })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, tenantId), eq(schema.member.userId, actor.id)));
    const [member] = await (write ? query.for("share") : query);
    const canSelect =
      !!member &&
      hasCabinetCapabilities(resolveCabinetAccess(member.role).capabilities, [
        CABINET_CAPABILITY.CREDENTIALS_MANAGE,
        CABINET_CAPABILITY.BILLING_REQUEST,
      ]);
    if (write && !canSelect) throw new ForbiddenException();
    return { ...authority, canSelect };
  }
  private async selections(tx: SubscriptionTransaction, tenantId: string) {
    const rows = await tx
      .select()
      .from(schema.workingDeviceRetentionSelections)
      .where(eq(schema.workingDeviceRetentionSelections.tenantId, tenantId))
      .orderBy(
        asc(schema.workingDeviceRetentionSelections.effectiveAt),
        asc(schema.workingDeviceRetentionSelections.id),
      );
    const members = await tx
      .select()
      .from(schema.workingDeviceRetentionMembers)
      .where(eq(schema.workingDeviceRetentionMembers.tenantId, tenantId))
      .orderBy(asc(schema.workingDeviceRetentionMembers.deviceId));
    return rows.map((row) => ({
      row,
      selection: deviceRetentionSelectionSchema.parse({
        id: row.id,
        revision: row.revision,
        preparedAt: row.preparedAt.toISOString(),
        observation: row.observation,
        selectedDeviceIds: members
          .filter((member) => member.selectionId === row.id)
          .map((member) => member.deviceId),
      }),
    }));
  }
  async inspect(tenantId: string, actor: DeviceLicensingActor): Promise<DeviceRetentionInspection> {
    return this.db.transaction(
      async (tx) => {
        const authority = await this.authority(tx, tenantId, actor, false);
        const at = new Date();
        const facts = await readDeviceRetentionFacts(tx, tenantId, this.entitlements, at);
        const saved = await this.selections(tx, tenantId);
        const selections = saved.map(({ row, selection }) => {
          const reached = row.effectiveAt <= at;
          // Compare durable terms plus present conditions after the boundary. Never
          // ask today's resolver to reconstruct historical rights from today's rows.
          const expected = retentionConditions(selection.observation.future);
          const conditionsMatch = reached
            ? replacementDigest(expected) === replacementDigest(facts.conditions)
            : true;
          return {
            selection,
            needsReview: row.factsFingerprint !== facts.semanticFingerprint || !conditionsMatch,
            boundaryReached: reached,
          };
        });
        const affected =
          (facts.conditions.limit !== null && facts.occupied.length > facts.conditions.limit) ||
          facts.occupied.some((row) => row.kind === "handheld" && !facts.conditions.handheld);
        const applicable = selections
          .filter((item) => item.boundaryReached && !item.needsReview)
          .at(-1);
        const selected = new Set(applicable?.selection.selectedDeviceIds ?? []);
        return deviceRetentionInspectionSchema.parse({
          canSelect: authority.canSelect,
          observation: facts.observation,
          selections,
          currentShadow: {
            awaitingSelection: affected && !applicable,
            affectedDeviceIds:
              affected || applicable
                ? facts.occupied
                    .filter((row) => !applicable || !selected.has(row.id))
                    .map((row) => row.id)
                : [],
            enforced: false,
          },
        });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
  async preview(
    tenantId: string,
    input: DeviceRetentionPreviewRequest,
    actor: DeviceLicensingActor,
  ): Promise<DeviceRetentionPreview> {
    const parsed = deviceRetentionPreviewRequestSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_retention_invalid" });
    const request = {
      ...parsed.data,
      selectedDeviceIds: [...parsed.data.selectedDeviceIds].sort(),
    };
    const payloadHash = replacementDigest(request);
    return this.transaction(tenantId, async (tx) => {
      const authority = await this.authority(tx, tenantId, actor, true);
      const p = schema.workingDeviceRetentionPreviews;
      const [existing] = await tx
        .select()
        .from(p)
        .where(and(eq(p.tenantId, tenantId), eq(p.requestId, request.requestId)));
      if (
        existing &&
        (existing.actorDomain !== actor.domain ||
          existing.actorId !== authority.id ||
          existing.payloadHash !== payloadHash)
      )
        conflict("request_conflict");
      await lockDeviceLicensingFacts(tx, tenantId);
      let at = new Date();
      const facts = await readDeviceRetentionFacts(tx, tenantId, this.entitlements, at);
      at = new Date();
      if (existing) {
        if (
          at >= existing.expiresAt ||
          envelopeSchema.parse(existing.payload).freshnessFingerprint !== facts.freshnessFingerprint
        )
          conflict("stale");
        const observed = publicPreview(existing);
        const current = (await this.selections(tx, tenantId)).find(
          (item) =>
            item.selection.observation.boundary.effectiveAt ===
            observed.observation.boundary.effectiveAt,
        );
        if ((current?.row.revision ?? 0) !== request.expectedRevision) conflict("stale");
        return observed;
      }
      const observation = facts.observation;
      if (!observation || request.boundaryKey !== observation.boundary.key) conflict("stale");
      const current = (await this.selections(tx, tenantId)).find(
        (item) => item.row.effectiveAt.toISOString() === observation.boundary.effectiveAt,
      );
      if ((current?.row.revision ?? 0) !== request.expectedRevision) conflict("stale");
      at = new Date();
      const expiresAt = new Date(
        Math.min(
          at.getTime() + 5 * 60_000,
          Date.parse(observation.boundary.effectiveAt),
          facts.nextChangeAt ? Date.parse(facts.nextChangeAt) : Infinity,
        ),
      );
      if (expiresAt <= at) conflict("stale");
      const id = randomUUID();
      const result = deviceRetentionPreviewSchema.safeParse({
        id,
        requestId: request.requestId,
        createdAt: at.toISOString(),
        expiresAt: expiresAt.toISOString(),
        expectedRevision: request.expectedRevision,
        selectedDeviceIds: request.selectedDeviceIds,
        observation,
      });
      if (!result.success) conflict("ineligible_selection");
      await tx.insert(p).values({
        id,
        tenantId,
        actorDomain: actor.domain,
        actorId: authority.id,
        requestId: request.requestId,
        payload: { request, freshnessFingerprint: facts.freshnessFingerprint },
        payloadHash,
        factsFingerprint: facts.semanticFingerprint,
        observation,
        expectedRevision: request.expectedRevision,
        selectedDeviceIds: request.selectedDeviceIds,
        createdAt: at,
        expiresAt,
      });
      return result.data;
    });
  }
  async confirm(
    tenantId: string,
    input: DeviceRetentionConfirm,
    actor: DeviceLicensingActor,
  ): Promise<DeviceRetentionReceipt> {
    const parsed = deviceRetentionConfirmSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: "device_retention_invalid" });
    const request = parsed.data;
    return this.transaction(tenantId, async (tx) => {
      const authority = await this.authority(tx, tenantId, actor, true);
      const p = schema.workingDeviceRetentionPreviews;
      const [preview] = await tx
        .select()
        .from(p)
        .where(and(eq(p.tenantId, tenantId), eq(p.id, request.previewId)));
      if (!preview) throw new NotFoundException();
      if (
        preview.actorDomain !== actor.domain ||
        preview.actorId !== authority.id ||
        preview.requestId !== request.requestId
      )
        conflict("request_conflict");
      if (preview.confirmedAt) return deviceRetentionReceiptSchema.parse(preview.response);
      await lockDeviceLicensingFacts(tx, tenantId);
      let at = new Date();
      if (at >= preview.expiresAt) conflict("stale");
      const intent = envelopeSchema.parse(preview.payload);
      const facts = await readDeviceRetentionFacts(tx, tenantId, this.entitlements, at);
      at = new Date();
      if (facts.freshnessFingerprint !== intent.freshnessFingerprint) conflict("stale");
      const observed = publicPreview(preview);
      const effectiveAt = new Date(observed.observation.boundary.effectiveAt);
      if (at >= effectiveAt || at >= preview.expiresAt) conflict("stale");
      const previous = (await this.selections(tx, tenantId)).find(
        (item) => item.row.effectiveAt.getTime() === effectiveAt.getTime(),
      );
      if ((previous?.row.revision ?? 0) !== preview.expectedRevision) conflict("stale");
      at = new Date();
      if (at >= effectiveAt || at >= preview.expiresAt) conflict("stale");
      if (preview.expectedRevision >= 2_147_483_647) conflict("revision_exhausted");
      const id = previous?.row.id ?? randomUUID();
      const selection = deviceRetentionSelectionSchema.parse({
        id,
        revision: preview.expectedRevision + 1,
        preparedAt: at.toISOString(),
        selectedDeviceIds: preview.selectedDeviceIds,
        observation: preview.observation,
      });
      const values = {
        previewId: preview.id,
        revision: selection.revision,
        actorDomain: actor.domain,
        actorId: authority.id,
        observation: preview.observation,
        factsFingerprint: preview.factsFingerprint,
        preparedAt: at,
      };
      if (previous)
        await tx
          .update(schema.workingDeviceRetentionSelections)
          .set(values)
          .where(
            and(
              eq(schema.workingDeviceRetentionSelections.tenantId, tenantId),
              eq(schema.workingDeviceRetentionSelections.id, id),
              eq(schema.workingDeviceRetentionSelections.revision, preview.expectedRevision),
            ),
          );
      else
        await tx
          .insert(schema.workingDeviceRetentionSelections)
          .values({ id, tenantId, effectiveAt, ...values });
      await tx
        .delete(schema.workingDeviceRetentionMembers)
        .where(
          and(
            eq(schema.workingDeviceRetentionMembers.tenantId, tenantId),
            eq(schema.workingDeviceRetentionMembers.selectionId, id),
          ),
        );
      if (selection.selectedDeviceIds.length)
        await tx.insert(schema.workingDeviceRetentionMembers).values(
          selection.selectedDeviceIds.map((deviceId) => ({
            tenantId,
            selectionId: id,
            deviceId,
          })),
        );
      const receipt = deviceRetentionReceiptSchema.parse({
        requestId: request.requestId,
        selection,
      });
      await tx.insert(schema.workingDeviceRetentionEvents).values({
        tenantId,
        selectionId: id,
        requestId: request.requestId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "selection_confirmed",
        before: previous?.selection ?? null,
        after: selection,
        result: receipt,
        createdAt: at,
      });
      await tx
        .update(p)
        .set({ confirmedAt: at, resultSelectionId: id, response: receipt })
        .where(eq(p.id, preview.id));
      if (actor.domain === "platform")
        await this.audit.record(tx, {
          actorPlatformUserId: authority.id,
          actorRole: authority.role,
          tenantId,
          action: "device.retention.selection_confirmed",
          outcome: "success",
          targetType: "working_device_retention_selection",
          targetId: id,
          reason: intent.request.reason,
          before: auditSelection(previous?.selection),
          after: auditSelection(selection),
          requestId: request.requestId,
        });
      return receipt;
    });
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
          // Take each statement snapshot after the serialization locks, so a
          // replacement/selection inserted while waiting cannot remain invisible.
          { isolationLevel: "read committed" },
        );
      } catch (error) {
        let cursor: unknown = error,
          retryable = false;
        for (let depth = 0; depth < 5 && cursor && typeof cursor === "object"; depth++) {
          if ("code" in cursor && cursor.code === "40001") retryable = true;
          if (
            "code" in cursor &&
            cursor.code === "23505" &&
            "constraint" in cursor &&
            [
              "working_device_retention_previews_tenant_request_uq",
              "working_device_retention_selections_tenant_boundary_uq",
              "working_device_retention_events_tenant_request_uq",
            ].includes(String(cursor.constraint))
          )
            retryable = true;
          cursor = "cause" in cursor ? cursor.cause : null;
        }
        if (!retryable || attempt >= 2) throw error;
      }
  }
}
