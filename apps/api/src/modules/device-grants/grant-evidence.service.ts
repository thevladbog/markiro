import { replacementTargetWaiting } from "../device-licensing/device-replacement-admission";
import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import {
  grantEventCost,
  productLabelValueDigest,
  type GrantEventType,
  type GrantOwner,
  type TaskGrant,
} from "@markiro/domain";
import {
  grantEvidenceReceiptSchema,
  type GrantEvidenceEnvelope,
  type GrantEvidenceReceipt,
} from "@markiro/platform-contracts";
import { DB } from "../../auth/auth.module";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import { GRANT_CLOCK } from "./grant-issuer.service";
import { lockCurrentGrantOwner, type GrantCredentialIdentity } from "./credential-epoch";
import { evidenceIdentity, retainedGrant, sanitizeEvidencePayload } from "./evidence-core";
import type { EvidenceTransactionHook } from "./evidence-transaction";

type Receipt = typeof schema.deviceGrantIngestReceipts.$inferSelect;
export interface EvidenceFact {
  pointer: string;
  eventType: GrantEventType;
  taskKind: TaskGrant["taskKind"];
  taskId: string;
  /** Durable native event identity, independent of outer batch and grant renewal. */
  identity: string;
  payload: unknown;
  units?: number;
  containers?: number;
  /** Checked against the immutable source inside the native owner's transaction. */
  matchesScope(scope: Record<string, unknown>): boolean;
}
class Replay extends Error {
  constructor(readonly response: GrantEvidenceReceipt) {
    super("evidence replay");
  }
}
class Quarantine extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}
const ownerValues = (owner: GrantOwner) => ({
  tenantId: owner.tenantId,
  ownerKind: owner.kind,
  stationDeviceId: owner.kind === "kiosk" ? null : owner.deviceId,
  kioskId: owner.kind === "kiosk" ? owner.deviceId : null,
  credentialEpoch: owner.credentialEpoch,
});
const jsonObject = (value: unknown): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Expected native response object");
  return parsed as Record<string, unknown>;
};

@Injectable()
export class GrantEvidenceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {}

  async ingest<T>(
    identity: GrantCredentialIdentity,
    operation: string,
    envelope: GrantEvidenceEnvelope,
    rawBody: Buffer | undefined,
    execute: (hook: EvidenceTransactionHook<T>) => Promise<T>,
    facts: (tx: SubscriptionTransaction, result: T) => Promise<EvidenceFact[]>,
    reconciliation: (result: T) => "applied" | "rejected" | "not_applied" = () => "applied",
  ): Promise<GrantEvidenceReceipt> {
    if (productLabelValueDigest(envelope.payload) !== envelope.payloadDigest)
      throw new BadRequestException({ code: "EVIDENCE_PAYLOAD_DIGEST_MISMATCH" });
    const requestIdentity = evidenceIdentity(identity, operation, envelope.batchId);
    const envelopeDigest = productLabelValueDigest(envelope);
    let initialQuarantine: GrantEvidenceReceipt | undefined;
    const receipt = await this.db.transaction(async (tx) => {
      const owner = await lockCurrentGrantOwner(tx, identity, this.now(), true);
      if (!owner) throw new UnauthorizedException();
      const [existing] = await tx
        .select()
        .from(schema.deviceGrantIngestReceipts)
        .where(
          and(
            eq(schema.deviceGrantIngestReceipts.tenantId, identity.tenantId),
            eq(schema.deviceGrantIngestReceipts.identity, requestIdentity),
          ),
        )
        .for("update");
      if (existing) {
        if (existing.envelopeDigest !== envelopeDigest)
          throw new ConflictException({ code: "EVIDENCE_IDENTITY_CONFLICT" });
        return existing;
      }
      const [configuration] = await tx
        .select()
        .from(schema.deviceGrantConfigurations)
        .where(
          and(
            eq(schema.deviceGrantConfigurations.tenantId, owner.tenantId),
            eq(schema.deviceGrantConfigurations.ownerKind, owner.kind),
            owner.kind === "kiosk"
              ? eq(schema.deviceGrantConfigurations.kioskId, owner.deviceId)
              : eq(schema.deviceGrantConfigurations.stationDeviceId, owner.deviceId),
          ),
        )
        .orderBy(desc(schema.deviceGrantConfigurations.sequence))
        .limit(1);
      const retainedPayload = { ...envelope, payload: sanitizeEvidencePayload(envelope.payload) };
      if (Buffer.byteLength(JSON.stringify(retainedPayload), "utf8") > 4 * 1024 * 1024)
        throw new BadRequestException({ code: "EVIDENCE_TOO_LARGE" });
      const [created] = await tx
        .insert(schema.deviceGrantIngestReceipts)
        .values({
          ...ownerValues(owner),
          identity: requestIdentity,
          operation,
          batchId: envelope.batchId,
          payloadDigest: envelope.payloadDigest,
          envelopeDigest,
          transportDigest: createHash("sha256")
            .update(rawBody ?? JSON.stringify(envelope))
            .digest("hex"),
          retainedPayload,
          mode: configuration?.mode ?? "observe",
          configurationId: configuration?.id ?? null,
          receivedAt: new Date(this.now()),
        })
        .returning();
      if (!created) throw new Error("Evidence receipt insert returned no row");
      if (
        owner.kind !== "kiosk" &&
        (await replacementTargetWaiting(tx, owner.tenantId, owner.deviceId, new Date(this.now())))
      ) {
        // Pin the boundary classification in the retention commit itself.
        // A process lost here must not resume these records as production once
        // the deadline passes, even when no native transaction ever started.
        initialQuarantine = this.response(
          created,
          "quarantined",
          "device_replacement_waiting",
          "not_applied",
          null,
          null,
        );
        await this.finalize(tx, owner, created, initialQuarantine, 0, envelope);
      }
      return created;
    });
    if (initialQuarantine) return initialQuarantine;
    if (receipt.finalResponse) return this.duplicate(receipt.finalResponse);
    let final: GrantEvidenceReceipt | undefined;
    const hook: EvidenceTransactionHook<T> = {
      before: async (tx) => {
        const owner = await this.lockReceipt(tx, identity, receipt.id);
        // Waiting is an operational fence even when rollout is still observe.
        // The native transaction rolls back; catch below finalizes retained evidence.
        if (
          owner.kind !== "kiosk" &&
          (await replacementTargetWaiting(tx, owner.tenantId, owner.deviceId, new Date(this.now())))
        )
          throw new Quarantine("device_replacement_waiting");
      },
      after: async (tx, result) => {
        const owner = await lockCurrentGrantOwner(tx, identity, this.now(), true);
        if (!owner) throw new UnauthorizedException();
        const actualFacts = await facts(tx, result);
        const reason = await this.charge(tx, owner, receipt, envelope, actualFacts);
        if (reason && receipt.mode === "strict") throw new Quarantine(reason);
        final = this.response(receipt, "accepted", reason, reconciliation(result), 200, result);
        if (!(await lockCurrentGrantOwner(tx, identity, this.now(), true)))
          throw new UnauthorizedException();
        await this.finalize(tx, owner, receipt, final, actualFacts.length, envelope);
      },
    };
    try {
      await execute(hook);
      if (!final) throw new Error("Native owner did not finalize evidence in its transaction");
      return final;
    } catch (error) {
      if (error instanceof Replay) return error.response;
      if (
        !(error instanceof Quarantine) &&
        (!(error instanceof HttpException) ||
          error.getStatus() >= 500 ||
          [401, 403].includes(error.getStatus()))
      )
        throw error;
      // Productive changes have rolled back. A new transaction preserves the
      // permanent classification; infrastructure/unknown commit stays pending.
      return this.db
        .transaction(async (tx) => {
          const owner = await this.lockReceipt(tx, identity, receipt.id);
          const response =
            error instanceof Quarantine
              ? this.response(receipt, "quarantined", error.reason, "not_applied", null, null)
              : this.response(
                  receipt,
                  "accepted",
                  null,
                  "rejected",
                  error.getStatus(),
                  error.getResponse(),
                );
          await this.finalize(tx, owner, receipt, response, 0, envelope);
          return response;
        })
        .catch((error) => {
          if (error instanceof Replay) return error.response;
          throw error;
        });
    }
  }
  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Invalid grant receipt clock");
    return now;
  }
  private duplicate(value: Record<string, unknown>): GrantEvidenceReceipt {
    return { ...grantEvidenceReceiptSchema.parse(value), outcome: "duplicate" };
  }
  private async lockReceipt(
    tx: SubscriptionTransaction,
    identity: GrantCredentialIdentity,
    id: string,
  ): Promise<GrantOwner> {
    const owner = await lockCurrentGrantOwner(tx, identity, this.now(), true);
    if (!owner) throw new UnauthorizedException();
    const [row] = await tx
      .select()
      .from(schema.deviceGrantIngestReceipts)
      .where(
        and(
          eq(schema.deviceGrantIngestReceipts.tenantId, owner.tenantId),
          eq(schema.deviceGrantIngestReceipts.id, id),
        ),
      )
      .for("update");
    if (!row) throw new Error("Evidence receipt disappeared");
    if (row.finalResponse) throw new Replay(this.duplicate(row.finalResponse));
    return owner;
  }
  private response(
    receipt: Receipt,
    outcome: "accepted" | "quarantined",
    reason: string | null,
    status: "applied" | "rejected" | "not_applied",
    statusCode: number | null,
    result: unknown,
  ): GrantEvidenceReceipt {
    return {
      protocol: "offline-grants-v1",
      batchId: receipt.batchId,
      receiptId: receipt.id,
      outcome,
      reason,
      reconciliation: {
        status,
        statusCode,
        result: result === undefined ? null : JSON.parse(JSON.stringify(result)),
      },
    };
  }
  private async finalize(
    tx: SubscriptionTransaction,
    owner: GrantOwner,
    receipt: Receipt,
    response: GrantEvidenceReceipt,
    eventCount: number,
    envelope: GrantEvidenceEnvelope,
  ) {
    await tx
      .update(schema.deviceGrantIngestReceipts)
      .set({ finalResponse: jsonObject(response), finalizedAt: new Date(this.now()) })
      .where(
        and(
          eq(schema.deviceGrantIngestReceipts.tenantId, owner.tenantId),
          eq(schema.deviceGrantIngestReceipts.id, receipt.id),
        ),
      );
    const ids = [...new Set(Object.values(envelope.eventGrants))];
    const issued = ids.length
      ? await tx
          .select()
          .from(schema.deviceGrantIssuances)
          .where(
            and(
              eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
              eq(schema.deviceGrantIssuances.ownerKind, owner.kind),
              owner.kind === "kiosk"
                ? eq(schema.deviceGrantIssuances.kioskId, owner.deviceId)
                : eq(schema.deviceGrantIssuances.stationDeviceId, owner.deviceId),
              inArray(schema.deviceGrantIssuances.grantId, ids),
            ),
          )
      : [];
    const originalGrants = issued
      .filter((row) => envelope.grants.includes(row.compactJws))
      .map((row) => ({ grantId: row.grantId, credentialEpoch: row.credentialEpoch }));

    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: owner.tenantId,
      actorUserId: null,
      action: "device.grant.evidence",
      outcome: response.outcome === "quarantined" ? "failure" : "success",
      targetType: "device_grant_receipt",
      targetId: receipt.id,
      after: {
        tenantId: owner.tenantId,
        ownerKind: owner.kind,
        deviceId: owner.deviceId,
        receiptCredentialEpoch: receipt.credentialEpoch,
        originalGrants,
        recoveredCredentialEpoch: owner.credentialEpoch,
        batchId: receipt.batchId,
        classification: response.outcome,
        reason: response.reason,
        reconciliation: response.reconciliation.status,
        eventCount,
        retainedBytes: Buffer.byteLength(JSON.stringify(receipt.retainedPayload)),
        payloadDigest: receipt.payloadDigest,
      },
    });
  }
  private async charge(
    tx: SubscriptionTransaction,
    owner: GrantOwner,
    receipt: Receipt,
    envelope: GrantEvidenceEnvelope,
    facts: EvidenceFact[],
  ): Promise<string | null> {
    const ids = [...new Set(Object.values(envelope.eventGrants))];
    const issuances = ids.length
      ? await tx
          .select()
          .from(schema.deviceGrantIssuances)
          .where(
            and(
              eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
              eq(schema.deviceGrantIssuances.ownerKind, owner.kind),
              owner.kind === "kiosk"
                ? eq(schema.deviceGrantIssuances.kioskId, owner.deviceId)
                : eq(schema.deviceGrantIssuances.stationDeviceId, owner.deviceId),
              inArray(schema.deviceGrantIssuances.grantId, ids),
            ),
          )
      : [];
    let diagnostic: string | null = null;
    const deny = (reason: string) => {
      diagnostic ??= reason;
      if (receipt.mode === "strict") throw new Quarantine(reason);
    };
    for (const fact of facts) {
      const id = envelope.eventGrants[`${fact.pointer}#${fact.eventType}`];
      const issuance = issuances.find((row) => row.grantId === id);
      const grant =
        issuance && envelope.grants.includes(issuance.compactJws)
          ? retainedGrant(issuance.compactJws, issuance.compactJws)
          : null;
      if (!grant || !issuance?.taskSourceId) {
        deny("grant_missing_or_unrecognized");
        continue;
      }
      if (
        grant.taskId !== fact.taskId ||
        grant.taskKind !== fact.taskKind ||
        !grant.eventTypes.includes(fact.eventType)
      ) {
        deny("grant_scope_mismatch");
        continue;
      }
      const [source] = await tx
        .select()
        .from(schema.deviceGrantTaskSources)
        .where(
          and(
            eq(schema.deviceGrantTaskSources.tenantId, owner.tenantId),
            eq(schema.deviceGrantTaskSources.id, issuance.taskSourceId),
          ),
        );
      if (
        !source ||
        source.snapshotDigest !== grant.snapshotDigest ||
        !fact.matchesScope(source.scope)
      ) {
        deny("grant_snapshot_mismatch");
        continue;
      }
      const identity = evidenceIdentity(
        owner,
        fact.eventType,
        productLabelValueDigest([fact.taskKind, fact.taskId, fact.identity]),
      );
      const digest = productLabelValueDigest(fact.payload);
      const [existing] = await tx
        .select()
        .from(schema.deviceGrantEffects)
        .where(
          and(
            eq(schema.deviceGrantEffects.tenantId, owner.tenantId),
            eq(schema.deviceGrantEffects.identity, identity),
          ),
        );
      if (existing) {
        if (existing.payloadDigest !== digest) deny("effect_identity_conflict");
        continue;
      }
      // A client timestamp cannot prove timely execution. The first server
      // receipt, or an already committed exact effect above, is the authority.
      if (
        receipt.receivedAt.getTime() < grant.notBefore ||
        receipt.receivedAt.getTime() >= grant.completeNotAfter
      ) {
        deny("completion_time_unproven");
        continue;
      }
      const cost = grantEventCost(fact.eventType, {
        ...(fact.units === undefined ? {} : { units: fact.units }),
        ...(fact.containers === undefined ? {} : { containers: fact.containers }),
      });
      if (!cost) {
        deny("cost_unproven");
        continue;
      }
      const changes: { id: string; consumed: number }[] = [];
      let invalid = false;
      for (const [lineId, amount] of Object.entries(cost).sort(([a], [b]) => a.localeCompare(b))) {
        const line = grant.budget.find((line) => line.id === lineId);
        if (!line) {
          invalid = true;
          break;
        }
        const counterIdentity = evidenceIdentity(
          owner,
          "consumption",
          productLabelValueDigest([grant.taskKind, grant.taskId, grant.snapshotDigest, lineId]),
        );
        await tx
          .insert(schema.deviceGrantConsumption)
          .values({
            ...ownerValues(owner),
            identity: counterIdentity,
            taskKind: grant.taskKind,
            taskId: grant.taskId,
            snapshotDigest: grant.snapshotDigest,
            budgetLineId: lineId,
          })
          .onConflictDoNothing();
        const [counter] = await tx
          .select()
          .from(schema.deviceGrantConsumption)
          .where(
            and(
              eq(schema.deviceGrantConsumption.tenantId, owner.tenantId),
              eq(schema.deviceGrantConsumption.identity, counterIdentity),
            ),
          )
          .for("update");
        if (
          !counter ||
          !Number.isSafeInteger(counter.consumed + amount) ||
          counter.consumed + amount > line.maximum
        ) {
          invalid = true;
          break;
        }
        changes.push({ id: counter.id, consumed: counter.consumed + amount });
      }
      if (invalid) {
        deny("budget_exceeded");
        continue;
      }
      for (const change of changes)
        await tx
          .update(schema.deviceGrantConsumption)
          .set({ consumed: change.consumed })
          .where(
            and(
              eq(schema.deviceGrantConsumption.tenantId, owner.tenantId),
              eq(schema.deviceGrantConsumption.id, change.id),
            ),
          );
      await tx.insert(schema.deviceGrantEffects).values({
        ...ownerValues({ ...owner, credentialEpoch: grant.credentialEpoch }),
        identity,
        payloadDigest: digest,
        receiptId: receipt.id,
        grantId: grant.grantId,
        taskKind: grant.taskKind,
        taskId: grant.taskId,
        snapshotDigest: grant.snapshotDigest,
        eventType: fact.eventType,
        cost,
      });
    }
    return diagnostic;
  }
}
