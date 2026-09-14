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
  offlineGrantPolicySchema,
  grantRollbackMemberSchema,
  platformGrantRollbackContracts,
  type GrantRollbackReason,
  type PlatformGrantRollbackCancelRequest,
  type PlatformGrantRollbackConfirmRequest,
  type PlatformGrantRollbackPreparation,
  type PlatformGrantRollbackPrepareRequest,
  type PlatformGrantRollbackReceipt,
  type PlatformPrincipal,
} from "@markiro/platform-contracts";
import { z } from "zod";
import { DB } from "../../auth/auth.module";
import { PlatformAuditService } from "../../platform-auth/platform-audit.service";
import { entitlementDigest } from "../../subscriptions/entitlement-snapshot-reader";
import { GRANT_CLOCK } from "./grant-issuer.service";
import {
  canonicalRollbackMembers,
  grantRollbackDigest,
  type GrantRollbackDigestSnapshot,
} from "./grant-rollback-digest";
import { readGrantRollbackFacts, type GrantRollbackFacts } from "./grant-rollback-facts";

const TTL_MS = 30 * 60 * 1_000;
const CONFIRM_REQUEST_CONSTRAINT = "offline_grant_rollback_confirm_request_uq";
const CANCEL_REQUEST_CONSTRAINT = "offline_grant_rollback_cancel_request_uq";

@Injectable()
export class PlatformGrantRollbackService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly audit: PlatformAuditService,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  async prepare(
    principal: PlatformPrincipal,
    request: PlatformGrantRollbackPrepareRequest,
  ): Promise<PlatformGrantRollbackPreparation> {
    const input = platformGrantRollbackContracts.prepare.body.parse(request);
    const requestHash = entitlementDigest(input);
    try {
      return await this.db.transaction(
        async (tx) => {
          const existing = await findByPrepareRequest(tx, input.requestId);
          if (existing) return replayPreparation(existing, requestHash);
          const at = this.now();
          await releaseExpired(tx, at);
          await lockActivations(tx, input.activationIds);
          const facts = await readGrantRollbackFacts(tx, input.activationIds);
          const reasons = rollbackReasons(facts, input.activationIds);
          if (!facts || reasons.length > 0)
            throw invalidRollback(reasons[0] ?? "activation_missing", reasons);
          const baseIds = new Set(facts.rows.map((row) => row.member.basePolicyId));
          if (baseIds.size !== 1) throw invalidRollback("base_policy_mismatch");
          const members = canonicalRollbackMembers(facts.rows.map((row) => row.member));
          const snapshot: GrantRollbackDigestSnapshot = {
            protocol: "offline-grants-rollback-v1",
            basePolicyId: members[0]!.basePolicyId,
            basePolicyHash: facts.basePolicyHash,
            members,
            decisionReference: input.decisionReference,
            asOf: at.toISOString(),
          };
          const rollbackDigest = grantRollbackDigest(snapshot);
          const expiresAt = new Date(at.getTime() + TTL_MS);
          const response = platformGrantRollbackContracts.prepare.response.parse({
            protocol: "offline-grants-rollback-v1",
            id: randomUUID(),
            state: "prepared",
            requestId: input.requestId,
            rollbackDigest,
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
            observePolicy: null,
          });
          await tx.insert(schema.offlineGrantRollbackPreparations).values({
            id: response.id,
            state: "prepared",
            basePolicyId: snapshot.basePolicyId,
            rollbackDigest,
            prepareRequestId: input.requestId,
            prepareRequestHash: requestHash,
            prepareResponse: response,
            decisionReference: input.decisionReference,
            snapshot: { ...snapshot },
            preparedByPlatformUserId: principal.userId,
            preparedAt: at,
            expiresAt,
          });
          await tx.insert(schema.offlineGrantRollbackMembers).values(
            members.map((member) => ({
              preparationId: response.id,
              activationId: member.activationId,
              activationPreparationId: member.activationPreparationId,
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
              basePolicyId: member.basePolicyId,
              strictPolicyId: member.strictPolicyId,
              activatedAt: new Date(member.activatedAt),
              reservationState: "prepared" as const,
            })),
          );
          await this.audit.record(tx, {
            actorPlatformUserId: principal.userId,
            actorRole: principal.role,
            action: "offline_grant.rollback.prepared",
            outcome: "success",
            tenantId: null,
            targetType: "offline_grant_rollback",
            targetId: response.id,
            reason: input.decisionReference,
            before: null,
            after: {
              state: "prepared",
              rollbackDigest,
              activationIds: members.map((member) => member.activationId),
              tenantCount: new Set(members.map((member) => member.tenantId)).size,
              deviceCount: members.length,
            },
            requestId: input.requestId,
          });
          return response;
        },
        { isolationLevel: "repeatable read" },
      );
    } catch (error) {
      if (uniqueConstraint(error) === "offline_grant_rollback_prepare_request_uq") {
        const replay = await this.db.transaction(async (tx) => {
          const existing = await findByPrepareRequest(tx, input.requestId);
          return existing ? replayPreparation(existing, requestHash) : null;
        });
        if (replay) return replay;
        throw new ConflictException({ code: "GRANT_ROLLBACK_REQUEST_CONFLICT" });
      }
      if (uniqueConstraint(error) === "offline_grant_rollback_members_active_reservation_uq")
        throw new ConflictException({ code: "GRANT_ROLLBACK_ALREADY_PREPARED" });
      throw error;
    }
  }

  async confirm(
    id: string,
    principal: PlatformPrincipal,
    request: PlatformGrantRollbackConfirmRequest,
  ): Promise<PlatformGrantRollbackReceipt> {
    const input = platformGrantRollbackContracts.confirm.body.parse(request);
    const requestHash = entitlementDigest(input);
    const operation = this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.offlineGrantRollbackPreparations)
        .where(eq(schema.offlineGrantRollbackPreparations.id, id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundException({ code: "GRANT_ROLLBACK_NOT_FOUND" });
      if (row.confirmRequestId) {
        if (row.confirmRequestId !== input.requestId || row.confirmRequestHash !== requestHash)
          throw requestConflict();
        return platformGrantRollbackContracts.confirm.response.parse(row.confirmResponse);
      }
      if (row.state !== "prepared")
        throw new ConflictException({ code: "GRANT_ROLLBACK_NOT_PREPARED" });
      if (row.rollbackDigest !== input.rollbackDigest) throw requestConflict();
      if (row.preparedByPlatformUserId === principal.userId)
        throw new ForbiddenException({ code: "GRANT_ROLLBACK_SECOND_OPERATOR_REQUIRED" });
      const at = this.now();
      if (at.getTime() >= row.expiresAt.getTime())
        throw new ConflictException({ code: "GRANT_ROLLBACK_EXPIRED" });
      const prepared = platformGrantRollbackContracts.prepare.response.parse(row.prepareResponse);
      await lockActivations(
        tx,
        prepared.members.map((member) => member.activationId),
      );
      const facts = await readGrantRollbackFacts(
        tx,
        prepared.members.map((member) => member.activationId),
      );
      const reasons = rollbackReasons(
        facts,
        prepared.members.map((member) => member.activationId),
      );
      const snapshot = parseSnapshot(row.snapshot);
      if (facts && reasons.length === 0) {
        const currentDigest = grantRollbackDigest({
          ...snapshot,
          members: canonicalRollbackMembers(facts.rows.map((fact) => fact.member)),
          basePolicyHash: facts.basePolicyHash,
        });
        if (currentDigest !== row.rollbackDigest) reasons.push("activation_mismatch");
      }
      if (!facts || reasons.length > 0) {
        const review = {
          ...prepared,
          state: "needs_review" as const,
          confirmedBy: { userId: principal.userId, role: principal.role },
          confirmedAt: at.toISOString(),
        };
        const receipt = platformGrantRollbackContracts.confirm.response.parse({
          status: "needs_review",
          requestId: input.requestId,
          preparation: review,
          reasons: uniqueReasons(reasons.length > 0 ? reasons : ["activation_mismatch"]),
        });
        await tx
          .update(schema.offlineGrantRollbackPreparations)
          .set({
            state: "needs_review",
            confirmRequestId: input.requestId,
            confirmRequestHash: requestHash,
            confirmResponse: receipt,
            confirmedByPlatformUserId: principal.userId,
            confirmedAt: at,
          })
          .where(eq(schema.offlineGrantRollbackPreparations.id, id));
        await releaseMembers(tx, id);
        await this.recordConfirmAudit(tx, principal, prepared, receipt, null);
        return receipt;
      }
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${facts.basePolicyKey}, 0))`,
      );
      const versions = await tx.execute<{ version: number }>(
        sql`select coalesce(max(version), 0)::int as version from entitlement_lifecycle_policies where policy_key = ${facts.basePolicyKey}`,
      );
      const nextVersion = (versions.rows[0]?.version ?? 0) + 1;
      const offlineGrant = offlineGrantPolicySchema.parse(facts.basePolicyPayload.offlineGrant);
      const deviceIds = [...new Set(prepared.members.map((member) => member.deviceId))].sort();
      const payload = {
        ...facts.basePolicyPayload,
        offlineGrant: {
          ...offlineGrant,
          rollout: {
            protocol: "offline-grants-v1" as const,
            mode: "observe" as const,
            deviceIds,
            decisionReference: row.decisionReference,
          },
        },
      };
      const observePolicyId = randomUUID();
      const payloadHash = entitlementDigest(payload);
      await tx.insert(schema.entitlementLifecyclePolicies).values({
        id: observePolicyId,
        policyKey: facts.basePolicyKey,
        version: nextVersion,
        status: "approved",
        payload,
        payloadHash,
        decisionReference: row.decisionReference,
        approvedAt: at,
        approvedByPlatformUserId: principal.userId,
        createdByPlatformUserId: row.preparedByPlatformUserId,
        createdAt: at,
      });
      const activationIds = prepared.members.map((member) => member.activationId);
      const updated = await tx
        .update(schema.offlineGrantDeviceActivations)
        .set({
          revokedAt: at,
          rollbackPreparationId: id,
          observePolicyId,
          rolledBackByPlatformUserId: principal.userId,
          rolledBackAt: at,
        })
        .where(
          and(
            sql`${schema.offlineGrantDeviceActivations.id} in (${sql.join(
              activationIds.map((activationId) => sql`${activationId}::uuid`),
              sql`, `,
            )})`,
            sql`${schema.offlineGrantDeviceActivations.revokedAt} is null`,
          ),
        )
        .returning({ id: schema.offlineGrantDeviceActivations.id });
      if (updated.length !== activationIds.length)
        throw new ConflictException({ code: "GRANT_ROLLBACK_ACTIVATION_CHANGED" });
      const observePolicy = {
        id: observePolicyId,
        policyKey: facts.basePolicyKey,
        version: nextVersion,
        status: "approved" as const,
        offlineGrant: payload.offlineGrant,
        payloadHash,
        decisionReference: row.decisionReference,
        approvedAt: at.toISOString(),
        approvedByPlatformUserId: principal.userId,
        createdByPlatformUserId: row.preparedByPlatformUserId,
        createdAt: at.toISOString(),
      };
      const confirmed = {
        ...prepared,
        state: "confirmed" as const,
        confirmedBy: { userId: principal.userId, role: principal.role },
        confirmedAt: at.toISOString(),
        observePolicy,
      };
      const receipt = platformGrantRollbackContracts.confirm.response.parse({
        status: "confirmed",
        requestId: input.requestId,
        preparation: confirmed,
      });
      await tx
        .update(schema.offlineGrantRollbackPreparations)
        .set({
          state: "confirmed",
          observePolicyId,
          confirmRequestId: input.requestId,
          confirmRequestHash: requestHash,
          confirmResponse: receipt,
          confirmedByPlatformUserId: principal.userId,
          confirmedAt: at,
        })
        .where(eq(schema.offlineGrantRollbackPreparations.id, id));
      await releaseMembers(tx, id);
      await this.recordConfirmAudit(tx, principal, prepared, receipt, payloadHash);
      return receipt;
    });
    return operation.catch((error: unknown) => {
      if (uniqueConstraint(error) === CONFIRM_REQUEST_CONSTRAINT) throw requestConflict();
      throw error;
    });
  }

  async cancel(
    id: string,
    principal: PlatformPrincipal,
    request: PlatformGrantRollbackCancelRequest,
  ): Promise<PlatformGrantRollbackPreparation> {
    const input = platformGrantRollbackContracts.cancel.body.parse(request);
    const requestHash = entitlementDigest(input);
    const operation = this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.offlineGrantRollbackPreparations)
        .where(eq(schema.offlineGrantRollbackPreparations.id, id))
        .for("update")
        .limit(1);
      if (!row) throw new NotFoundException({ code: "GRANT_ROLLBACK_NOT_FOUND" });
      if (row.cancelRequestId) {
        if (row.cancelRequestId !== input.requestId || row.cancelRequestHash !== requestHash)
          throw requestConflict();
        return platformGrantRollbackContracts.cancel.response.parse(row.cancelResponse);
      }
      if (row.state !== "prepared" && row.state !== "needs_review")
        throw new ConflictException({ code: "GRANT_ROLLBACK_NOT_PREPARED" });
      const at = this.now();
      const current = materialize(row, at);
      const response = platformGrantRollbackContracts.cancel.response.parse({
        ...current,
        state: "cancelled",
        cancelledBy: { userId: principal.userId, role: principal.role },
        cancelledAt: at.toISOString(),
        cancellationReason: input.reason,
      });
      await tx
        .update(schema.offlineGrantRollbackPreparations)
        .set({
          state: "cancelled",
          cancelRequestId: input.requestId,
          cancelRequestHash: requestHash,
          cancelResponse: response,
          cancelledByPlatformUserId: principal.userId,
          cancelledAt: at,
          cancellationReason: input.reason,
        })
        .where(eq(schema.offlineGrantRollbackPreparations.id, id));
      await releaseMembers(tx, id);
      await this.audit.record(tx, {
        actorPlatformUserId: principal.userId,
        actorRole: principal.role,
        action: "offline_grant.rollback.cancelled",
        outcome: "success",
        tenantId: null,
        targetType: "offline_grant_rollback",
        targetId: id,
        reason: input.reason,
        before: { state: row.state },
        after: { state: "cancelled", requestId: input.requestId },
        requestId: input.requestId,
      });
      return response;
    });
    return operation.catch((error: unknown) => {
      if (uniqueConstraint(error) === CANCEL_REQUEST_CONSTRAINT) throw requestConflict();
      throw error;
    });
  }

  async detail(id: string): Promise<PlatformGrantRollbackPreparation> {
    const [row] = await this.db
      .select()
      .from(schema.offlineGrantRollbackPreparations)
      .where(eq(schema.offlineGrantRollbackPreparations.id, id))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "GRANT_ROLLBACK_NOT_FOUND" });
    return materialize(row, this.now());
  }

  async list(input: unknown) {
    const query = platformGrantRollbackContracts.list.query.parse(input);
    const at = this.now();
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const t = schema.offlineGrantRollbackPreparations;
    const conditions: SQL[] = [];
    if (query.state === "expired")
      conditions.push(and(eq(t.state, "prepared"), sql`${t.expiresAt} <= ${at}`)!);
    else if (query.state === "prepared")
      conditions.push(and(eq(t.state, "prepared"), gt(t.expiresAt, at))!);
    else if (query.state) conditions.push(eq(t.state, query.state));
    if (cursor) {
      const timestamp = new Date(cursor.timestamp);
      conditions.push(
        or(lt(t.preparedAt, timestamp), and(eq(t.preparedAt, timestamp), lt(t.id, cursor.id)))!,
      );
    }
    const rows = await this.db
      .select()
      .from(t)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(t.preparedAt), desc(t.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    return platformGrantRollbackContracts.list.response.parse({
      items: page.map((row) => materialize(row, at)),
      nextCursor:
        rows.length > query.limit && page.length
          ? encodeCursor(page.at(-1)!.preparedAt, page.at(-1)!.id)
          : null,
    });
  }

  async candidates(input: unknown) {
    const query = platformGrantRollbackContracts.candidates.query.parse(input);
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const conditions = [
      sql`activation.revoked_at is null`,
      sql`preparation.state = 'confirmed'`,
      sql`preparation.rollout_policy_id = activation.rollout_policy_id`,
    ];
    if (query.tenantId) conditions.push(sql`activation.tenant_id = ${query.tenantId}`);
    if (query.deviceKind) conditions.push(sql`activation.owner_kind = ${query.deviceKind}`);
    if (cursor)
      conditions.push(
        sql`(activation.activated_at, activation.id) < (${new Date(cursor.timestamp)}, ${cursor.id}::uuid)`,
      );
    const result = await this.db.execute<{
      activationId: string;
      tenantId: string;
      tenantName: string;
      subscriptionId: string;
      deviceId: string;
      deviceKind: "station" | "handheld" | "kiosk";
      deviceName: string;
      basePolicyId: string;
      strictPolicyId: string;
      strictDecisionReference: string;
      activatedAt: Date | string;
    }>(sql`
      select activation.id as "activationId", activation.tenant_id as "tenantId", org.name as "tenantName",
        activation.subscription_id as "subscriptionId", coalesce(activation.station_device_id, activation.kiosk_id) as "deviceId",
        activation.owner_kind as "deviceKind", coalesce(station.name, kiosk.name) as "deviceName",
        activation.base_policy_id as "basePolicyId", activation.rollout_policy_id as "strictPolicyId",
        policy.decision_reference as "strictDecisionReference", activation.activated_at as "activatedAt"
      from offline_grant_device_activations activation
      join offline_grant_activation_preparations preparation on preparation.id = activation.preparation_id
      join entitlement_lifecycle_policies policy on policy.id = activation.rollout_policy_id
      join organization org on org.id = activation.tenant_id
      left join station_devices station on station.tenant_id = activation.tenant_id and station.id = activation.station_device_id
      left join kiosks kiosk on kiosk.tenant_id = activation.tenant_id and kiosk.id = activation.kiosk_id
      where ${sql.join(conditions, sql` and `)}
      order by activation.activated_at desc, activation.id desc limit ${query.limit + 1}
    `);
    const page = result.rows.slice(0, query.limit);
    return platformGrantRollbackContracts.candidates.response.parse({
      items: page.map((row) => ({ ...row, activatedAt: new Date(row.activatedAt).toISOString() })),
      nextCursor:
        result.rows.length > query.limit && page.length
          ? encodeCursor(new Date(page.at(-1)!.activatedAt), page.at(-1)!.activationId)
          : null,
    });
  }

  private async recordConfirmAudit(
    tx: RollbackTx,
    principal: PlatformPrincipal,
    prepared: PlatformGrantRollbackPreparation,
    receipt: PlatformGrantRollbackReceipt,
    payloadHash: string | null,
  ) {
    await this.audit.record(tx, {
      actorPlatformUserId: principal.userId,
      actorRole: principal.role,
      action: "offline_grant.rollback.confirmed",
      outcome: receipt.status,
      tenantId: null,
      targetType: "offline_grant_rollback",
      targetId: prepared.id,
      reason: receipt.status === "needs_review" ? receipt.reasons.join(",") : null,
      before: {
        state: "prepared",
        mode: "strict",
        preparedByPlatformUserId: prepared.preparedBy.userId,
      },
      after: {
        state: receipt.preparation.state,
        mode: receipt.status === "confirmed" ? "observe" : "strict",
        requestId: receipt.requestId,
        rollbackDigest: prepared.rollbackDigest,
        observePolicyHash: payloadHash,
        activationIds: prepared.members.map((member) => member.activationId),
        tenantCount: new Set(prepared.members.map((member) => member.tenantId)).size,
        deviceCount: prepared.members.length,
      },
      requestId: receipt.requestId,
    });
  }

  private now(): Date {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid rollback clock");
    return new Date(value);
  }
}

type RollbackTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type RollbackRow = typeof schema.offlineGrantRollbackPreparations.$inferSelect;
async function findByPrepareRequest(tx: RollbackTx, requestId: string) {
  const [row] = await tx
    .select()
    .from(schema.offlineGrantRollbackPreparations)
    .where(eq(schema.offlineGrantRollbackPreparations.prepareRequestId, requestId))
    .limit(1);
  return row;
}
function replayPreparation(
  row: NonNullable<Awaited<ReturnType<typeof findByPrepareRequest>>>,
  hash: string,
) {
  if (row.prepareRequestHash !== hash) throw requestConflict();
  return platformGrantRollbackContracts.prepare.response.parse(row.prepareResponse);
}
function materialize(row: RollbackRow, at: Date): PlatformGrantRollbackPreparation {
  if (row.state === "confirmed" || row.state === "needs_review")
    return platformGrantRollbackContracts.confirm.response.parse(row.confirmResponse).preparation;
  if (row.state === "cancelled")
    return platformGrantRollbackContracts.cancel.response.parse(row.cancelResponse);
  const prepared = platformGrantRollbackContracts.prepare.response.parse(row.prepareResponse);
  return at >= row.expiresAt
    ? platformGrantRollbackContracts.detail.response.parse({ ...prepared, state: "expired" })
    : prepared;
}
async function releaseExpired(tx: RollbackTx, at: Date) {
  await tx.execute(
    sql`update offline_grant_rollback_members member set reservation_state = 'released' from offline_grant_rollback_preparations preparation where member.preparation_id = preparation.id and member.reservation_state = 'prepared' and preparation.state = 'prepared' and preparation.expires_at <= ${at}`,
  );
}
async function releaseMembers(tx: RollbackTx, id: string) {
  await tx
    .update(schema.offlineGrantRollbackMembers)
    .set({ reservationState: "released" })
    .where(eq(schema.offlineGrantRollbackMembers.preparationId, id));
}
async function lockActivations(tx: RollbackTx, ids: readonly string[]) {
  await tx.execute(
    sql`select id from offline_grant_device_activations where id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}) order by id for update`,
  );
}
function rollbackReasons(
  facts: GrantRollbackFacts | null,
  expectedIds: readonly string[],
): GrantRollbackReason[] {
  if (!facts) return ["activation_missing"];
  const reasons: GrantRollbackReason[] = [];
  if (
    facts.rows.length !== expectedIds.length ||
    new Set(facts.rows.map((row) => row.member.activationId)).size !== expectedIds.length
  )
    reasons.push("activation_missing");
  for (const row of facts.rows) {
    if (!row.active) reasons.push("activation_inactive");
    if (!row.preparationConfirmed) reasons.push("activation_mismatch");
    if (row.currentBasePolicyId !== row.member.basePolicyId) reasons.push("base_policy_mismatch");
    if (!row.deviceKindMatches) reasons.push("device_mismatch");
    if (!row.credentialMatches) reasons.push("credential_mismatch");
    if (!row.assignmentMatches) reasons.push("assignment_mismatch");
    if (!row.configurationMatches) reasons.push("configuration_mismatch");
    const strict = facts.strictPolicies.get(row.member.strictPolicyId);
    if (
      !strict ||
      strict.rollout?.mode !== "strict" ||
      !strict.rollout.deviceIds.includes(row.member.deviceId) ||
      strict.maxOfflineMs !== facts.basePolicy.maxOfflineMs ||
      strict.maxCompletionMs !== facts.basePolicy.maxCompletionMs ||
      entitlementDigest(strict.taskBounds) !== entitlementDigest(facts.basePolicy.taskBounds)
    )
      reasons.push("strict_policy_mismatch");
  }
  return uniqueReasons(reasons);
}
function uniqueReasons(reasons: readonly GrantRollbackReason[]): GrantRollbackReason[] {
  return [...new Set(reasons)];
}
function invalidRollback(
  reason: GrantRollbackReason,
  reasons: readonly GrantRollbackReason[] = [reason],
) {
  return new BadRequestException({
    code: `GRANT_ROLLBACK_${reason.toUpperCase()}`,
    reasons: uniqueReasons(reasons),
  });
}
function requestConflict() {
  return new ConflictException({ code: "GRANT_ROLLBACK_REQUEST_CONFLICT" });
}
function uniqueConstraint(error: unknown): string | null {
  let current = error;
  const visited = new Set<object>();
  while (current && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    const record = current as Record<string, unknown>;
    if (record.code === "23505" && typeof record.constraint === "string") return record.constraint;
    current = record.cause;
  }
  return null;
}
const cursorSchema = z
  .object({ version: z.literal(1), timestamp: z.iso.datetime({ offset: true }), id: z.uuid() })
  .strict();
function encodeCursor(timestamp: Date, id: string) {
  return Buffer.from(
    JSON.stringify({ version: 1, timestamp: timestamp.toISOString(), id }),
  ).toString("base64url");
}
function decodeCursor(raw: string): z.infer<typeof cursorSchema> {
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) throw new Error();
    return cursorSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
  } catch {
    throw new BadRequestException({ code: "GRANT_ROLLBACK_INVALID_CURSOR" });
  }
}
function parseSnapshot(value: unknown): GrantRollbackDigestSnapshot {
  return z
    .object({
      protocol: z.literal("offline-grants-rollback-v1"),
      basePolicyId: z.uuid(),
      basePolicyHash: z.string().regex(/^[0-9a-f]{64}$/),
      members: z.array(grantRollbackMemberSchema),
      decisionReference: z.string().min(1),
      asOf: z.iso.datetime({ offset: true }),
    })
    .strict()
    .parse(value);
}
