import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { and, desc, eq, gt, lt, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  platformGrantActivationContracts,
  offlineGrantPolicySchema,
  type GrantReadinessReason,
  type PlatformGrantActivationCancelRequest,
  type PlatformGrantActivationConfirmRequest,
  type PlatformGrantActivationPreparation,
  type PlatformGrantActivationPrepareRequest,
  type PlatformGrantActivationReceipt,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import {
  activationMembers,
  activationTargetPolicy,
  readGrantActivationFacts,
  type GrantActivationFacts,
} from "./grant-activation-facts";
import {
  grantActivationPreparationDigest,
  type GrantActivationDigestSnapshot,
} from "./grant-activation-digest";
import { classifyGrantReadiness } from "./grant-readiness-facts";
import {
  canonicalGrantReadinessFacts,
  toGrantReadinessRow,
} from "./platform-grant-readiness.service";
import { GRANT_CLOCK } from "./grant-issuer.service";
import { GRANT_SIGNING_CONFIGURATION, type GrantSigningConfiguration } from "./grant-keyset";

const PREPARATION_TTL_MS = 30 * 60 * 1_000;
const CONFIRM_REQUEST_CONSTRAINT = "offline_grant_activation_confirm_request_uq";
const CANCEL_REQUEST_CONSTRAINT = "offline_grant_activation_cancel_request_uq";
const previewAuditSchema = z
  .object({
    policyRevision: z.string().min(1),
    mode: z.literal("strict"),
    asOf: z.iso.datetime({ offset: true }),
    previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .passthrough();

@Injectable()
export class PlatformGrantActivationService {
  private readonly signingFacts: {
    configured: boolean;
    keysetRevision: string | null;
    retiredKids: ReadonlySet<string>;
  };

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(GRANT_SIGNING_CONFIGURATION) signing: GrantSigningConfiguration | null,
    private readonly audit: PlatformAuditService,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {
    this.signingFacts = {
      configured: Boolean(signing && signing.keyset.keys.length > 0),
      keysetRevision: signing?.keyset.revision ?? null,
      retiredKids: new Set(signing?.keyset.retiredKids ?? []),
    };
  }

  async prepare(
    principal: PlatformPrincipal,
    request: PlatformGrantActivationPrepareRequest,
  ): Promise<PlatformGrantActivationPreparation> {
    const input = platformGrantActivationContracts.prepare.body.parse(request);
    const requestHash = entitlementDigest(input);
    try {
      return await this.db.transaction(
        async (tx) => {
          const existing = await findPreparationByRequest(tx, input.requestId);
          if (existing) return replayPreparation(existing, requestHash);

          const at = this.now();
          await tx.execute(sql`
            update offline_grant_activation_members member
               set reservation_state = 'released'
              from offline_grant_activation_preparations preparation
             where member.preparation_id = preparation.id
               and member.reservation_state = 'prepared'
               and preparation.state = 'prepared'
               and preparation.expires_at <= ${at}
          `);
          const [auditRow] = await tx
            .select()
            .from(schema.platformAuditEvents)
            .where(
              and(
                eq(schema.platformAuditEvents.action, "offline_grant.readiness.previewed"),
                eq(schema.platformAuditEvents.requestId, input.previewRequestId),
                eq(schema.platformAuditEvents.targetId, input.policyId),
              ),
            )
            .orderBy(desc(schema.platformAuditEvents.createdAt))
            .limit(1);
          const previewAudit = previewAuditSchema.safeParse(auditRow?.after);
          if (!auditRow || !previewAudit.success)
            throw invalidPreparation("GRANT_ACTIVATION_PREVIEW_NOT_FOUND");
          if (previewAudit.data.previewDigest !== input.previewDigest)
            throw invalidPreparation("GRANT_ACTIVATION_PREVIEW_DIGEST_MISMATCH");
          const active = await tx.execute<{ id: string }>(sql`
            select id
              from offline_grant_device_activations
             where revoked_at is null
               and (
                 station_device_id in (${sql.join(
                   input.deviceIds.map((deviceId) => sql`${deviceId}::uuid`),
                   sql`, `,
                 )})
                 or kiosk_id in (${sql.join(
                   input.deviceIds.map((deviceId) => sql`${deviceId}::uuid`),
                   sql`, `,
                 )})
               )
             limit 1
          `);
          if (active.rows.length > 0)
            throw new ConflictException({ code: "GRANT_ACTIVATION_DEVICE_ALREADY_ACTIVE" });

          const facts = await readGrantActivationFacts(
            tx,
            { deviceIds: input.deviceIds, policyId: input.policyId },
            at,
            this.signingFacts,
          );
          if (!facts) throw invalidPreparation("GRANT_ACTIVATION_POLICY_NOT_APPROVED");
          if (facts.rows.length !== input.deviceIds.length)
            throw invalidPreparation("GRANT_ACTIVATION_DEVICE_NOT_FOUND");
          const found = new Set(facts.rows.map((row) => row.deviceId));
          if (found.size !== input.deviceIds.length || input.deviceIds.some((id) => !found.has(id)))
            throw invalidPreparation("GRANT_ACTIVATION_DEVICE_NOT_FOUND");

          const targetPolicy = activationTargetPolicy(facts.basePolicy);
          if (previewAudit.data.policyRevision !== targetPolicy.revision)
            throw invalidPreparation("GRANT_ACTIVATION_PREVIEW_STALE");
          const previewAt = new Date(previewAudit.data.asOf);
          const previewRows = facts.rows.map((row) =>
            toGrantReadinessRow(row, targetPolicy, previewAt),
          );
          const recomputedPreviewDigest = entitlementDigest({
            protocol: "offline-grants-readiness-preview-v1",
            policyId: targetPolicy.id,
            policyRevision: targetPolicy.revision,
            mode: "strict",
            deviceIds: [...input.deviceIds].sort(),
            facts: canonicalGrantReadinessFacts(previewRows),
            asOf: previewAudit.data.asOf,
          });
          if (recomputedPreviewDigest !== input.previewDigest)
            throw invalidPreparation("GRANT_ACTIVATION_PREVIEW_STALE");

          const blocked = facts.rows.flatMap(
            (row) => classifyGrantReadiness(row, targetPolicy, at).reasons,
          );
          if (blocked.length > 0)
            throw invalidPreparation("GRANT_ACTIVATION_READINESS_BLOCKED", blocked);

          const members = activationMembers(facts.rows);
          const basePolicy = {
            id: facts.basePolicy.id,
            policyKey: facts.basePolicy.policyKey,
            version: facts.basePolicy.version,
            payloadHash: facts.basePolicy.payloadHash,
            revision: facts.basePolicy.revision,
          };
          const snapshot: GrantActivationDigestSnapshot = {
            protocol: "offline-grants-activation-v1",
            previewRequestId: input.previewRequestId,
            previewDigest: input.previewDigest,
            basePolicy,
            members,
            decisionReference: input.decisionReference,
            asOf: at.toISOString(),
          };
          const preparationDigest = grantActivationPreparationDigest(snapshot);
          const expiresAtMs = at.getTime() + PREPARATION_TTL_MS;
          if (!Number.isSafeInteger(expiresAtMs)) throw new Error("Invalid activation expiry");
          const expiresAt = new Date(expiresAtMs);
          const response = platformGrantActivationContracts.prepare.response.parse({
            protocol: "offline-grants-activation-v1",
            id: randomUUID(),
            state: "prepared",
            requestId: input.requestId,
            previewRequestId: input.previewRequestId,
            previewDigest: input.previewDigest,
            preparationDigest,
            basePolicy,
            members,
            decisionReference: input.decisionReference,
            preparedBy: { userId: principal.userId, role: principal.role },
            preparedAt: at.toISOString(),
            expiresAt: expiresAt.toISOString(),
            confirmedBy: null,
            confirmedAt: null,
            cancelledBy: null,
            cancelledAt: null,
            cancellationReason: null,
            rolloutPolicy: null,
          });
          await tx.insert(schema.offlineGrantActivationPreparations).values({
            id: response.id,
            state: "prepared",
            basePolicyId: input.policyId,
            previewRequestId: input.previewRequestId,
            previewDigest: input.previewDigest,
            preparationDigest,
            prepareRequestId: input.requestId,
            prepareRequestHash: requestHash,
            prepareResponse: response,
            decisionReference: input.decisionReference,
            snapshot,
            preparedByPlatformUserId: principal.userId,
            preparedAt: at,
            expiresAt,
          });
          await tx.insert(schema.offlineGrantActivationMembers).values(
            members.map((member) => ({
              preparationId: response.id,
              tenantId: member.tenantId,
              tenantName: member.tenantName,
              subscriptionId: member.subscriptionId,
              ownerKind: member.deviceKind,
              stationDeviceId: member.deviceKind === "kiosk" ? null : member.deviceId,
              kioskId: member.deviceKind === "kiosk" ? member.deviceId : null,
              deviceName: member.deviceName,
              credentialEpoch: member.credentialEpoch,
              assignmentId: member.assignmentId,
              configurationId: member.configurationId,
              clientReportId: member.clientReportId,
              verifiedGrantId: member.verifiedGrantId,
              keysetRevision: member.keysetRevision,
              entitlementRevision: member.entitlementRevision,
              reservationState: "prepared" as const,
            })),
          );
          await this.audit.record(tx, {
            actorPlatformUserId: principal.userId,
            actorRole: principal.role,
            action: "offline_grant.activation.prepared",
            outcome: "success",
            tenantId: null,
            targetType: "offline_grant_activation",
            targetId: response.id,
            reason: input.decisionReference,
            before: null,
            after: {
              requestId: input.requestId,
              basePolicyId: input.policyId,
              previewDigest: input.previewDigest,
              preparationDigest,
              tenantCount: new Set(members.map((member) => member.tenantId)).size,
              deviceCount: members.length,
              expiresAt: response.expiresAt,
            },
            requestId: input.requestId,
          });
          return response;
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.db.transaction(async (tx) => {
        const existing = await findPreparationByRequest(tx, input.requestId);
        return existing ? replayPreparation(existing, requestHash) : null;
      });
      if (replay) return replay;
      throw new ConflictException({ code: "GRANT_ACTIVATION_DEVICE_ALREADY_PREPARED" });
    }
  }

  async confirm(
    id: string,
    principal: PlatformPrincipal,
    request: PlatformGrantActivationConfirmRequest,
  ): Promise<PlatformGrantActivationReceipt> {
    const input = platformGrantActivationContracts.confirm.body.parse(request);
    const requestHash = entitlementDigest(input);
    const transaction = this.db.transaction(
      async (tx) => {
        const [preparation] = await tx
          .select()
          .from(schema.offlineGrantActivationPreparations)
          .where(eq(schema.offlineGrantActivationPreparations.id, id))
          .for("update")
          .limit(1);
        if (!preparation) throw new NotFoundException({ code: "GRANT_ACTIVATION_NOT_FOUND" });
        if (preparation.confirmRequestId) {
          if (
            preparation.confirmRequestId !== input.requestId ||
            preparation.confirmRequestHash !== requestHash
          )
            throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
          return platformGrantActivationContracts.confirm.response.parse(
            preparation.confirmResponse,
          );
        }
        const [requestOwner] = await tx
          .select({ id: schema.offlineGrantActivationPreparations.id })
          .from(schema.offlineGrantActivationPreparations)
          .where(eq(schema.offlineGrantActivationPreparations.confirmRequestId, input.requestId))
          .limit(1);
        if (requestOwner)
          throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
        if (preparation.state !== "prepared")
          throw new ConflictException({ code: "GRANT_ACTIVATION_NOT_PREPARED" });
        if (preparation.preparationDigest !== input.preparationDigest)
          throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
        if (preparation.preparedByPlatformUserId === principal.userId)
          throw new ForbiddenException({ code: "GRANT_ACTIVATION_SECOND_OPERATOR_REQUIRED" });
        const at = this.now();
        if (at.getTime() >= preparation.expiresAt.getTime())
          throw new ConflictException({ code: "GRANT_ACTIVATION_EXPIRED" });
        const preparedResponse = platformGrantActivationContracts.prepare.response.parse(
          preparation.prepareResponse,
        );
        await lockActivationAuthority(tx, preparedResponse, preparation.basePolicyId);
        const facts = await readGrantActivationFacts(
          tx,
          {
            deviceIds: preparedResponse.members.map((member) => member.deviceId),
            policyId: preparation.basePolicyId,
          },
          at,
          this.signingFacts,
        );
        const staleReasons = facts
          ? confirmationDriftReasons(facts, preparedResponse, at)
          : ["target_policy_not_approved" as const];
        if (!facts || staleReasons.length > 0) {
          const needsReview = {
            ...preparedResponse,
            state: "needs_review" as const,
            confirmedBy: { userId: principal.userId, role: principal.role },
            confirmedAt: at.toISOString(),
          };
          const receipt = platformGrantActivationContracts.confirm.response.parse({
            status: "needs_review",
            requestId: input.requestId,
            preparation: needsReview,
            reasons: staleReasons,
          });
          await tx
            .update(schema.offlineGrantActivationPreparations)
            .set({
              state: "needs_review",
              confirmRequestId: input.requestId,
              confirmRequestHash: requestHash,
              confirmResponse: receipt,
              confirmedByPlatformUserId: principal.userId,
              confirmedAt: at,
            })
            .where(eq(schema.offlineGrantActivationPreparations.id, id));
          await releasePreparationMembers(tx, id);
          await this.recordConfirmationAudit(tx, principal, preparedResponse, receipt, null);
          return receipt;
        }

        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${facts.basePolicy.policyKey}, 0))`,
        );
        const versionResult = await tx.execute<{ version: number }>(sql`
          select coalesce(max(version), 0)::int as version
            from entitlement_lifecycle_policies
           where policy_key = ${facts.basePolicy.policyKey}
        `);
        const nextVersion = (versionResult.rows[0]?.version ?? 0) + 1;
        const offlineGrant = offlineGrantPolicySchema.parse(facts.basePolicy.payload.offlineGrant);
        const deviceIds = preparedResponse.members
          .map((member) => member.deviceId)
          .sort((left, right) => left.localeCompare(right));
        const rolloutPayload = {
          ...facts.basePolicy.payload,
          offlineGrant: {
            ...offlineGrant,
            rollout: {
              protocol: "offline-grants-v1" as const,
              mode: "strict" as const,
              deviceIds,
              decisionReference: preparation.decisionReference,
            },
          },
        };
        const rolloutPolicyId = randomUUID();
        const rolloutHash = entitlementDigest(rolloutPayload);
        await tx.insert(schema.entitlementLifecyclePolicies).values({
          id: rolloutPolicyId,
          policyKey: facts.basePolicy.policyKey,
          version: nextVersion,
          status: "approved",
          payload: rolloutPayload,
          payloadHash: rolloutHash,
          decisionReference: preparation.decisionReference,
          approvedAt: at,
          approvedByPlatformUserId: principal.userId,
          createdByPlatformUserId: preparation.preparedByPlatformUserId,
          createdAt: at,
        });
        const activationIds = preparedResponse.members.map(() => randomUUID());
        await tx.insert(schema.offlineGrantDeviceActivations).values(
          preparedResponse.members.map((member, index) => ({
            id: activationIds[index]!,
            preparationId: id,
            tenantId: member.tenantId,
            subscriptionId: member.subscriptionId,
            ownerKind: member.deviceKind,
            stationDeviceId: member.deviceKind === "kiosk" ? null : member.deviceId,
            kioskId: member.deviceKind === "kiosk" ? member.deviceId : null,
            credentialEpoch: member.credentialEpoch,
            basePolicyId: preparation.basePolicyId,
            rolloutPolicyId,
            activatedByPlatformUserId: principal.userId,
            activatedAt: at,
          })),
        );
        const rolloutPolicy = {
          id: rolloutPolicyId,
          policyKey: facts.basePolicy.policyKey,
          version: nextVersion,
          status: "approved" as const,
          offlineGrant: rolloutPayload.offlineGrant,
          payloadHash: rolloutHash,
          decisionReference: preparation.decisionReference,
          approvedAt: at.toISOString(),
          approvedByPlatformUserId: principal.userId,
          createdByPlatformUserId: preparation.preparedByPlatformUserId,
          createdAt: at.toISOString(),
        };
        const confirmedPreparation = {
          ...preparedResponse,
          state: "confirmed" as const,
          confirmedBy: { userId: principal.userId, role: principal.role },
          confirmedAt: at.toISOString(),
          rolloutPolicy,
        };
        const receipt = platformGrantActivationContracts.confirm.response.parse({
          status: "confirmed",
          requestId: input.requestId,
          preparation: confirmedPreparation,
          activationIds,
        });
        await tx
          .update(schema.offlineGrantActivationPreparations)
          .set({
            state: "confirmed",
            rolloutPolicyId,
            confirmRequestId: input.requestId,
            confirmRequestHash: requestHash,
            confirmResponse: receipt,
            confirmedByPlatformUserId: principal.userId,
            confirmedAt: at,
          })
          .where(eq(schema.offlineGrantActivationPreparations.id, id));
        await releasePreparationMembers(tx, id);
        await this.recordConfirmationAudit(tx, principal, preparedResponse, receipt, rolloutHash);
        return receipt;
      },
      { isolationLevel: "read committed" },
    );
    return transaction.catch((error: unknown) => {
      if (uniqueViolationConstraint(error) === CONFIRM_REQUEST_CONSTRAINT) {
        throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
      }
      throw error;
    });
  }

  async cancel(
    id: string,
    principal: PlatformPrincipal,
    request: PlatformGrantActivationCancelRequest,
  ): Promise<PlatformGrantActivationPreparation> {
    const input = platformGrantActivationContracts.cancel.body.parse(request);
    const requestHash = entitlementDigest(input);
    const transaction = this.db.transaction(async (tx) => {
      const [preparation] = await tx
        .select()
        .from(schema.offlineGrantActivationPreparations)
        .where(eq(schema.offlineGrantActivationPreparations.id, id))
        .for("update")
        .limit(1);
      if (!preparation) throw new NotFoundException({ code: "GRANT_ACTIVATION_NOT_FOUND" });
      if (preparation.cancelRequestId) {
        if (
          preparation.cancelRequestId !== input.requestId ||
          preparation.cancelRequestHash !== requestHash
        )
          throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
        return platformGrantActivationContracts.cancel.response.parse(preparation.cancelResponse);
      }
      const [requestOwner] = await tx
        .select({ id: schema.offlineGrantActivationPreparations.id })
        .from(schema.offlineGrantActivationPreparations)
        .where(eq(schema.offlineGrantActivationPreparations.cancelRequestId, input.requestId))
        .limit(1);
      if (requestOwner) throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
      if (preparation.state !== "prepared" && preparation.state !== "needs_review")
        throw new ConflictException({ code: "GRANT_ACTIVATION_NOT_PREPARED" });
      const at = this.now();
      const preparedResponse = materializePreparation(preparation, at);
      const response = platformGrantActivationContracts.cancel.response.parse({
        ...preparedResponse,
        state: "cancelled",
        cancelledBy: { userId: principal.userId, role: principal.role },
        cancelledAt: at.toISOString(),
        cancellationReason: input.reason,
      });
      await tx
        .update(schema.offlineGrantActivationPreparations)
        .set({
          state: "cancelled",
          cancelRequestId: input.requestId,
          cancelRequestHash: requestHash,
          cancelResponse: response,
          cancelledByPlatformUserId: principal.userId,
          cancelledAt: at,
          cancellationReason: input.reason,
        })
        .where(eq(schema.offlineGrantActivationPreparations.id, id));
      await releasePreparationMembers(tx, id);
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "offline_grant.activation.cancelled",
        outcome: "success",
        tenantId: null,
        targetType: "offline_grant_activation",
        targetId: id,
        reason: input.reason,
        before: { state: preparation.state },
        after: { state: "cancelled", requestId: input.requestId },
        requestId: input.requestId,
      });
      return response;
    });
    return transaction.catch((error: unknown) => {
      if (uniqueViolationConstraint(error) === CANCEL_REQUEST_CONSTRAINT) {
        throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
      }
      throw error;
    });
  }

  async detail(id: string): Promise<PlatformGrantActivationPreparation> {
    const [row] = await this.db
      .select()
      .from(schema.offlineGrantActivationPreparations)
      .where(eq(schema.offlineGrantActivationPreparations.id, id))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "GRANT_ACTIVATION_NOT_FOUND" });
    return materializePreparation(row, this.now());
  }

  async list(input: unknown) {
    const query = platformGrantActivationContracts.list.query.parse(input);
    const at = this.now();
    const cursor = query.cursor ? decodeActivationCursor(query.cursor) : null;
    const table = schema.offlineGrantActivationPreparations;
    const conditions: SQL[] = [];
    if (query.state === "expired") {
      conditions.push(and(eq(table.state, "prepared"), sql`${table.expiresAt} <= ${at}`)!);
    } else if (query.state === "prepared") {
      conditions.push(and(eq(table.state, "prepared"), gt(table.expiresAt, at))!);
    } else if (query.state) {
      conditions.push(eq(table.state, query.state));
    }
    if (cursor) {
      const preparedAt = new Date(cursor.preparedAt);
      conditions.push(
        or(
          lt(table.preparedAt, preparedAt),
          and(eq(table.preparedAt, preparedAt), lt(table.id, cursor.id)),
        )!,
      );
    }
    const rows = await this.db
      .select()
      .from(table)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(table.preparedAt), desc(table.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return platformGrantActivationContracts.list.response.parse({
      items: page.map((row) => materializePreparation(row, at)),
      nextCursor:
        rows.length > query.limit && page.length > 0 ? encodeActivationCursor(page.at(-1)!) : null,
    });
  }

  private async recordConfirmationAudit(
    tx: ActivationTx,
    principal: PlatformPrincipal,
    preparation: PlatformGrantActivationPreparation,
    receipt: PlatformGrantActivationReceipt,
    rolloutHash: string | null,
  ) {
    await this.audit.record(tx, {
      actorPlatformUserId: principal.userId,
      actorRole: principal.role,
      action: "offline_grant.activation.confirmed",
      outcome: receipt.status,
      tenantId: null,
      targetType: "offline_grant_activation",
      targetId: preparation.id,
      reason: receipt.status === "needs_review" ? receipt.reasons.join(",") : null,
      before: {
        state: "prepared",
        preparedByPlatformUserId: preparation.preparedBy.userId,
        basePolicyHash: preparation.basePolicy.payloadHash,
      },
      after: {
        state: receipt.preparation.state,
        confirmedByPlatformUserId: principal.userId,
        requestId: receipt.requestId,
        rolloutHash,
        preparationDigest: preparation.preparationDigest,
        tenantCount: new Set(preparation.members.map((member) => member.tenantId)).size,
        deviceCount: preparation.members.length,
      },
      requestId: receipt.requestId,
    });
  }

  private now(): Date {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid activation clock");
    return new Date(value);
  }
}

type ActivationTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type PreparationRow = typeof schema.offlineGrantActivationPreparations.$inferSelect;

async function findPreparationByRequest(tx: ActivationTx, requestId: string) {
  const [row] = await tx
    .select()
    .from(schema.offlineGrantActivationPreparations)
    .where(eq(schema.offlineGrantActivationPreparations.prepareRequestId, requestId))
    .limit(1);
  return row;
}

function replayPreparation(
  row: NonNullable<Awaited<ReturnType<typeof findPreparationByRequest>>>,
  requestHash: string,
): PlatformGrantActivationPreparation {
  if (row.prepareRequestHash !== requestHash)
    throw new ConflictException({ code: "GRANT_ACTIVATION_REQUEST_CONFLICT" });
  return platformGrantActivationContracts.prepare.response.parse(row.prepareResponse);
}

function materializePreparation(row: PreparationRow, at: Date): PlatformGrantActivationPreparation {
  if (row.state === "confirmed" || row.state === "needs_review") {
    return platformGrantActivationContracts.confirm.response.parse(row.confirmResponse).preparation;
  }
  if (row.state === "cancelled")
    return platformGrantActivationContracts.cancel.response.parse(row.cancelResponse);
  const prepared = platformGrantActivationContracts.prepare.response.parse(row.prepareResponse);
  return at.getTime() >= row.expiresAt.getTime()
    ? platformGrantActivationContracts.detail.response.parse({ ...prepared, state: "expired" })
    : prepared;
}

const activationCursorSchema = z
  .object({
    version: z.literal(1),
    preparedAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

function encodeActivationCursor(row: PreparationRow): string {
  return Buffer.from(
    JSON.stringify({ version: 1, preparedAt: row.preparedAt.toISOString(), id: row.id }),
  ).toString("base64url");
}

function decodeActivationCursor(raw: string): z.infer<typeof activationCursorSchema> {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    return activationCursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new BadRequestException({ code: "GRANT_ACTIVATION_INVALID_CURSOR" });
  }
}

function invalidPreparation(code: string, reasons?: readonly string[]) {
  return new BadRequestException({ code, ...(reasons ? { reasons: [...new Set(reasons)] } : {}) });
}

function confirmationDriftReasons(
  facts: GrantActivationFacts,
  prepared: PlatformGrantActivationPreparation,
  at: Date,
): GrantReadinessReason[] {
  if (facts.rows.length !== prepared.members.length) return ["configuration_mismatch"];
  const target = activationTargetPolicy(facts.basePolicy);
  const reasons = facts.rows.flatMap((row) => classifyGrantReadiness(row, target, at).reasons);
  if (reasons.length > 0) return [...new Set(reasons)];
  const basePolicy = {
    id: facts.basePolicy.id,
    policyKey: facts.basePolicy.policyKey,
    version: facts.basePolicy.version,
    payloadHash: facts.basePolicy.payloadHash,
    revision: facts.basePolicy.revision,
  };
  if (
    entitlementDigest({ basePolicy, members: activationMembers(facts.rows) }) !==
    entitlementDigest({ basePolicy: prepared.basePolicy, members: prepared.members })
  )
    return ["configuration_mismatch"];
  return [];
}

async function releasePreparationMembers(tx: ActivationTx, preparationId: string) {
  await tx
    .update(schema.offlineGrantActivationMembers)
    .set({ reservationState: "released" })
    .where(eq(schema.offlineGrantActivationMembers.preparationId, preparationId));
}

async function lockActivationAuthority(
  tx: ActivationTx,
  preparation: PlatformGrantActivationPreparation,
  basePolicyId: string,
) {
  const membersJson = JSON.stringify(
    preparation.members.map((member) => ({
      tenantId: member.tenantId,
      subscriptionId: member.subscriptionId,
      deviceId: member.deviceId,
      deviceKind: member.deviceKind,
      assignmentId: member.assignmentId,
      configurationId: member.configurationId,
      clientReportId: member.clientReportId,
      verifiedGrantId: member.verifiedGrantId,
    })),
  );
  const members = sql`jsonb_to_recordset(${membersJson}::jsonb) as selected(
    "tenantId" text, "subscriptionId" uuid, "deviceId" uuid, "deviceKind" text,
    "assignmentId" uuid, "configurationId" uuid, "clientReportId" uuid,
    "verifiedGrantId" uuid
  )`;
  await tx.execute(
    sql`select id from entitlement_lifecycle_policies where id = ${basePolicyId}::uuid for update`,
  );
  await tx.execute(sql`
    select subscription.id from tenant_subscriptions subscription
    inner join ${members} on selected."tenantId" = subscription.tenant_id
      and selected."subscriptionId" = subscription.id
    order by subscription.tenant_id, subscription.id for update of subscription
  `);
  await tx.execute(sql`
    select device.id from station_devices device
    inner join ${members} on selected."tenantId" = device.tenant_id
      and selected."deviceId" = device.id and selected."deviceKind" <> 'kiosk'
    order by device.tenant_id, device.id for update of device
  `);
  await tx.execute(sql`
    select kiosk.id from kiosks kiosk
    inner join ${members} on selected."tenantId" = kiosk.tenant_id
      and selected."deviceId" = kiosk.id and selected."deviceKind" = 'kiosk'
    order by kiosk.tenant_id, kiosk.id for update of kiosk
  `);
  await tx.execute(sql`
    select assignment.id from working_device_assignments assignment
    inner join ${members} on selected."tenantId" = assignment.tenant_id
      and selected."assignmentId" = assignment.id
    order by assignment.tenant_id, assignment.id for update of assignment
  `);
  await tx.execute(sql`
    select fact.id from device_grant_configurations fact
    inner join ${members} on selected."tenantId" = fact.tenant_id
      and selected."configurationId" = fact.id
    order by fact.tenant_id, fact.id for update of fact
  `);
  await tx.execute(sql`
    select fact.id from device_grant_client_readiness_reports fact
    inner join ${members} on selected."tenantId" = fact.tenant_id
      and selected."clientReportId" = fact.id
    order by fact.tenant_id, fact.id for update of fact
  `);
  await tx.execute(sql`
    select fact.grant_id from device_grant_issuances fact
    inner join ${members} on selected."tenantId" = fact.tenant_id
      and selected."verifiedGrantId" = fact.grant_id
    order by fact.tenant_id, fact.grant_id for update of fact
  `);
  await tx.execute(sql`
    select revision.tenant_id from entitlement_revisions revision
    inner join ${members} on selected."tenantId" = revision.tenant_id
    order by revision.tenant_id for update of revision
  `);
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && (error as { code?: unknown }).code === "23505") return true;
  return "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause);
}

function uniqueViolationConstraint(error: unknown): string | null {
  let current = error;
  const visited = new Set<object>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "23505" && typeof record.constraint === "string") {
      return record.constraint;
    }
    current = record.cause;
  }
  return null;
}
