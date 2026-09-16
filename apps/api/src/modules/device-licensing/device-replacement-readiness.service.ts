import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq } from "drizzle-orm";
import {
  deviceReplacementCurrentIntentResponseSchema,
  deviceReplacementDrainRequestSchema,
  deviceReplacementObservationSchema,
  deviceReplacementReadinessRequestSchema,
  deviceReplacementReadinessResponseSchema,
  deviceReplacementReceiptSchema,
  platformUuidSchema,
  type DeviceReplacementDrainRequest,
  type DeviceReplacementReadinessRequest,
  type DeviceReplacementReadinessResponse,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { lockGrantFacts } from "../device-grants/grant-admission";
import {
  lockCurrentGrantOwner,
  type GrantCredentialIdentity,
} from "../device-grants/credential-epoch";
import {
  requireDeviceLicensingActor,
  type DeviceLicensingActor,
} from "./device-licensing-authority";
import { readDeviceReplacementFacts, replacementDigest } from "./device-replacement-facts";
import { deviceReplacementServerWorkBlockers } from "./device-replacement-readiness-work";
import {
  replacementPreparationProjection,
  replacementStorageRevisionHighWater,
  REPLACEMENT_INTENT_TTL_MS,
} from "./device-replacement-readiness-projection";

const intents = schema.workingDeviceReplacementReadinessIntents;
const reports = schema.workingDeviceReplacementReadinessReports;
const preparations = schema.workingDeviceReplacementPreparations;
const conflict = () => new ConflictException({ code: "device_replacement_request_conflict" });
type Reasons = Extract<
  DeviceReplacementReadinessResponse["eligibility"],
  { status: "blocked" }
>["reasons"];
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

@Injectable()
export class DeviceReplacementReadinessService {
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
  async requestDrain(
    tenantId: string,
    preparationId: string,
    input: DeviceReplacementDrainRequest,
    actor: DeviceLicensingActor,
  ) {
    const parsed = deviceReplacementDrainRequestSchema.safeParse(input);
    if (!parsed.success || !platformUuidSchema.safeParse(preparationId).success)
      throw new BadRequestException();
    const request = parsed.data;
    const hash = replacementDigest({ operation: "drain", preparationId, ...request });
    return this.transaction(tenantId, async (tx) => {
      const authority = await requireDeviceLicensingActor(tx, tenantId, actor, true);
      const [event] = await tx
        .select()
        .from(schema.workingDeviceEvents)
        .where(
          and(
            eq(schema.workingDeviceEvents.tenantId, tenantId),
            eq(schema.workingDeviceEvents.requestId, request.requestId),
          ),
        );
      if (event) {
        if (
          event.action !== "replacement_drain_requested" ||
          event.actorDomain !== actor.domain ||
          event.actorId !== authority.id ||
          event.requestHash !== hash
        )
          throw conflict();
        return deviceReplacementReceiptSchema.parse(event.response);
      }
      const [usedPreview] = await tx
        .select()
        .from(schema.workingDeviceReplacementPreviews)
        .where(
          and(
            eq(schema.workingDeviceReplacementPreviews.tenantId, tenantId),
            eq(schema.workingDeviceReplacementPreviews.requestId, request.requestId),
          ),
        );
      if (usedPreview) throw conflict();
      const [row] = await tx
        .select()
        .from(preparations)
        .where(and(eq(preparations.tenantId, tenantId), eq(preparations.id, preparationId)))
        .for("update");
      if (!row) throw new NotFoundException();
      if (
        !["prepared", "draining", "ready"].includes(row.state) ||
        row.revision !== request.expectedRevision
      )
        throw new ConflictException({ code: "device_replacement_stale" });
      const facts = await this.facts(tx, tenantId, row.deviceId, row.observation);
      if (facts.device.revokedAt || !facts.device.apiKeyId)
        throw new ConflictException({ code: "device_replacement_source_ineligible" });
      const now = new Date();
      const before = await replacementPreparationProjection(tx, row);
      await tx
        .update(intents)
        .set({ state: "superseded", closedAt: now })
        .where(
          and(
            eq(intents.tenantId, tenantId),
            eq(intents.preparationId, preparationId),
            eq(intents.state, "active"),
          ),
        );
      const [intent] = await tx
        .insert(intents)
        .values({
          tenantId,
          deviceId: row.deviceId,
          preparationId,
          actorDomain: actor.domain,
          actorId: authority.id,
          requestId: request.requestId,
          requestHash: hash,
          credentialEpoch: facts.device.credentialEpoch,
          preparationRevision: row.revision + 1,
          assignmentRevision: facts.assignment.revision,
          entitlementRevision: facts.revision.revision,
          usageRevision: facts.revision.usageRevision,
          grantConfigurationId: facts.configuration?.id ?? null,
          grantConfigurationSequence: facts.configuration?.sequence ?? null,
          factsFingerprint: facts.replacement.readinessFingerprint,
          requestedAt: now,
          expiresAt: new Date(now.getTime() + REPLACEMENT_INTENT_TTL_MS),
        })
        .returning();
      if (!intent) throw new Error("Drain intent insert failed");
      const [next] = await tx
        .update(preparations)
        .set({ state: "draining", revision: row.revision + 1 })
        .where(and(eq(preparations.tenantId, tenantId), eq(preparations.id, row.id)))
        .returning();
      if (!next) throw new Error("Drain preparation update failed");
      const receipt = deviceReplacementReceiptSchema.parse({
        requestId: request.requestId,
        preparation: await replacementPreparationProjection(tx, next),
      });
      await tx.update(intents).set({ response: receipt }).where(eq(intents.id, intent.id));
      await tx.insert(schema.workingDeviceEvents).values({
        tenantId,
        deviceId: row.deviceId,
        actorDomain: actor.domain,
        actorId: authority.id,
        action: "replacement_drain_requested",
        requestId: request.requestId,
        requestHash: hash,
        before,
        after: receipt.preparation,
        response: receipt,
      });
      if (actor.domain === "platform")
        await this.audit.record(tx, {
          actorPlatformUserId: authority.id,
          actorRole: authority.role,
          tenantId,
          action: "device.replacement.drain_requested",
          outcome: "success",
          targetType: "station_device",
          targetId: row.deviceId,
          reason: null,
          before,
          after: receipt.preparation,
          requestId: request.requestId,
        });
      else
        await tx.insert(schema.tenantAuditEvents).values({
          organizationId: tenantId,
          actorUserId: authority.id,
          action: "device.replacement.drain_requested",
          outcome: "success",
          targetType: "station_device",
          targetId: row.deviceId,
          before,
          after: receipt.preparation,
          requestId: request.requestId,
        });
      return receipt;
    });
  }
  async currentIntent(identity: GrantCredentialIdentity) {
    return this.transaction(identity.tenantId, async (tx) => {
      const owner = await lockCurrentGrantOwner(tx, identity, Date.now());
      if (!owner || owner.kind === "kiosk") throw new UnauthorizedException();
      const [intent] = await tx
        .select()
        .from(intents)
        .where(
          and(
            eq(intents.tenantId, owner.tenantId),
            eq(intents.deviceId, owner.deviceId),
            eq(intents.credentialEpoch, owner.credentialEpoch),
            eq(intents.state, "active"),
          ),
        );
      // An expired intent remains visible: expiry must never silently release durable drain.
      return deviceReplacementCurrentIntentResponseSchema.parse(
        intent
          ? {
              intentId: intent.id,
              preparationId: intent.preparationId,
              credentialEpoch: owner.credentialEpoch,
              preparationRevision: intent.preparationRevision,
              requestedAt: intent.requestedAt.toISOString(),
              expiresAt: intent.expiresAt.toISOString(),
            }
          : null,
      );
    });
  }
  async report(
    identity: GrantCredentialIdentity,
    input: DeviceReplacementReadinessRequest,
  ): Promise<DeviceReplacementReadinessResponse> {
    const parsed = deviceReplacementReadinessRequestSchema.safeParse(input);
    if (!parsed.success || Buffer.byteLength(JSON.stringify(input)) > 240_000)
      throw new BadRequestException();
    const body = parsed.data;
    const hash = replacementDigest(body);
    return this.transaction(identity.tenantId, async (tx) => {
      const now = new Date();
      const owner = await lockCurrentGrantOwner(tx, identity, now.getTime());
      if (!owner || owner.kind === "kiosk" || owner.credentialEpoch !== body.credentialEpoch)
        throw new UnauthorizedException();
      const [existing] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.tenantId, owner.tenantId), eq(reports.requestId, body.requestId)));
      if (existing) {
        if (
          existing.deviceId !== owner.deviceId ||
          existing.credentialEpoch !== owner.credentialEpoch ||
          existing.payloadHash !== hash
        )
          throw conflict();
        return deviceReplacementReadinessResponseSchema.parse(existing.response);
      }
      const [usedCommand] = await tx
        .select({ id: schema.workingDeviceEvents.id })
        .from(schema.workingDeviceEvents)
        .where(
          and(
            eq(schema.workingDeviceEvents.tenantId, owner.tenantId),
            eq(schema.workingDeviceEvents.requestId, body.requestId),
          ),
        );
      if (usedCommand) throw conflict();
      const [intent] = await tx
        .select()
        .from(intents)
        .where(
          and(
            eq(intents.tenantId, owner.tenantId),
            eq(intents.deviceId, owner.deviceId),
            eq(intents.id, body.intentId),
          ),
        );
      if (!intent) throw new NotFoundException();
      if (intent.credentialEpoch !== owner.credentialEpoch) throw new UnauthorizedException();
      const [row] = await tx
        .select()
        .from(preparations)
        .where(
          and(eq(preparations.tenantId, owner.tenantId), eq(preparations.id, intent.preparationId)),
        )
        .for("update");
      if (!row) throw new NotFoundException();
      const [previous] = await tx
        .select()
        .from(reports)
        .where(and(eq(reports.tenantId, owner.tenantId), eq(reports.intentId, intent.id)))
        .orderBy(desc(reports.reportSequence))
        .limit(1);
      const [usedSequence] = await tx
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.tenantId, owner.tenantId),
            eq(reports.intentId, intent.id),
            eq(reports.reportSequence, body.reportSequence),
          ),
        );
      if (usedSequence) throw conflict();
      const storageHighWater = await replacementStorageRevisionHighWater(tx, intent);
      const reasons: Reasons = [];
      const stale =
        intent.state !== "active" ||
        now >= intent.expiresAt ||
        !["draining", "ready"].includes(row.state) ||
        body.storageRevision < storageHighWater ||
        (previous !== undefined && body.reportSequence < previous.reportSequence);
      if (stale) reasons.push("report_stale");
      const facts = await this.facts(tx, owner.tenantId, owner.deviceId, row.observation);
      if (
        facts.replacement.readinessFingerprint !== intent.factsFingerprint ||
        facts.assignment.revision !== intent.assignmentRevision ||
        facts.revision.revision !== intent.entitlementRevision ||
        facts.revision.usageRevision !== intent.usageRevision ||
        (facts.configuration?.id ?? null) !== intent.grantConfigurationId ||
        (facts.configuration?.sequence ?? null) !== intent.grantConfigurationSequence
      )
        reasons.push("facts_changed");
      const counters = {
        ...body.pending,
        conflicts: body.conflicts,
        unknownPrints: body.unknownPrints,
      };
      const unsupportedChannels = channels.filter((channel) => counters[channel] === "unsupported");
      if (unsupportedChannels.length) reasons.push("client_upgrade_required");
      channels.forEach((channel, index) => {
        const value = counters[channel];
        const reason = pendingReasons[index];
        if (typeof value === "number" && value > 0 && reason) reasons.push(reason);
      });
      if (body.activeTasks.length) reasons.push("active_tasks");
      reasons.push(...deviceReplacementServerWorkBlockers(facts.replacement.work, owner.deviceId));
      const issuances = await tx
        .select()
        .from(schema.deviceGrantIssuances)
        .where(
          and(
            eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
            eq(schema.deviceGrantIssuances.stationDeviceId, owner.deviceId),
            eq(schema.deviceGrantIssuances.ownerKind, owner.kind),
            eq(schema.deviceGrantIssuances.credentialEpoch, owner.credentialEpoch),
          ),
        );
      // A known expired grant cannot start new work. Unknown IDs fail closed; client times are absent.
      if (
        body.installedGrants.some(({ grantId }) => {
          const grant = issuances.find((g) => g.grantId === grantId);
          return (
            !grant ||
            (grant.kindOfGrant === "device" && (!grant.startNotAfter || grant.startNotAfter > now))
          );
        })
      )
        reasons.push("installed_grants");
      const eligibility = reasons.length
        ? { status: "blocked", reasons: [...new Set(reasons)] }
        : { status: "eligible", reasons: [] };
      const response = deviceReplacementReadinessResponseSchema.parse({
        requestId: body.requestId,
        intentId: intent.id,
        receivedAt: now.toISOString(),
        unsupportedChannels,
        eligibility,
      });
      const before = await replacementPreparationProjection(tx, row);
      const [report] = await tx
        .insert(reports)
        .values({
          tenantId: owner.tenantId,
          deviceId: owner.deviceId,
          preparationId: row.id,
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
      if (!report) throw new Error("Readiness report insert failed");
      if (!stale) {
        const state = response.eligibility.status === "eligible" ? "ready" : "draining";
        if (state !== row.state) {
          const [next] = await tx
            .update(preparations)
            .set({ state, revision: row.revision + 1 })
            .where(and(eq(preparations.tenantId, owner.tenantId), eq(preparations.id, row.id)))
            .returning();
          if (!next) throw new Error("Readiness state update failed");
          if (state === "ready") {
            const receipt = {
              requestId: body.requestId,
              preparation: await replacementPreparationProjection(tx, next),
            };
            await tx.insert(schema.workingDeviceEvents).values({
              tenantId: owner.tenantId,
              deviceId: owner.deviceId,
              actorDomain: "device",
              actorId: owner.deviceId,
              action: "replacement_ready",
              requestId: body.requestId,
              requestHash: hash,
              before,
              after: receipt.preparation,
              response: receipt,
            });
          }
        }
      }
      await tx.insert(schema.tenantAuditEvents).values({
        organizationId: owner.tenantId,
        actorUserId: null,
        action: "device.replacement.readiness.reported",
        outcome: "success",
        targetType: "device_replacement_readiness_report",
        targetId: report.id,
        requestId: body.requestId,
        after: {
          actorDomain: "station_device",
          actorId: owner.deviceId,
          deviceKind: owner.kind,
          credentialEpoch: owner.credentialEpoch,
          intentId: intent.id,
          eligibility: response.eligibility,
        },
      });
      return response;
    });
  }
  private async facts(
    tx: SubscriptionTransaction,
    tenantId: string,
    deviceId: string,
    observation: unknown,
  ) {
    const replacement = await readDeviceReplacementFacts(
      tx,
      tenantId,
      deviceId,
      deviceReplacementObservationSchema.parse(observation).target,
      this.entitlements,
    );
    const [device] = await tx
      .select()
      .from(schema.stationDevices)
      .where(
        and(eq(schema.stationDevices.tenantId, tenantId), eq(schema.stationDevices.id, deviceId)),
      );
    const [assignment] = await tx
      .select()
      .from(schema.workingDeviceAssignments)
      .where(
        and(
          eq(schema.workingDeviceAssignments.tenantId, tenantId),
          eq(schema.workingDeviceAssignments.deviceId, deviceId),
        ),
      );
    const [revision] = await tx
      .select()
      .from(schema.entitlementRevisions)
      .where(eq(schema.entitlementRevisions.tenantId, tenantId));
    const [configuration] = await tx
      .select()
      .from(schema.deviceGrantConfigurations)
      .where(
        and(
          eq(schema.deviceGrantConfigurations.tenantId, tenantId),
          eq(schema.deviceGrantConfigurations.stationDeviceId, deviceId),
        ),
      )
      .orderBy(desc(schema.deviceGrantConfigurations.sequence))
      .limit(1);
    if (!device || !assignment || !revision)
      throw new ConflictException({ code: "device_replacement_facts_unknown" });
    return { replacement, device, assignment, revision, configuration };
  }
}
