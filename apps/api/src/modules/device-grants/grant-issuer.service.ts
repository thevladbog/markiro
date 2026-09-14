import { resolveGrantRollout } from "./grant-rollout";
import { randomUUID, createHash } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import type {
  GrantCapability,
  GrantEnvelope,
  GrantIssueResult,
  GrantOwner,
  OfflineGrant,
  GrantTaskSnapshot,
} from "@markiro/domain";
import type { GrantConfiguration, KioskGrantReservationResult } from "@markiro/platform-contracts";
import { evaluateEntitlementOperation } from "../../subscriptions/entitlement-projection";
import { DB } from "../../auth/auth.module";
import { EntitlementsService } from "../../subscriptions/entitlements.service";
import type { SubscriptionTransaction } from "../../subscriptions/entitlements.types";
import {
  entitlementCanonical,
  entitlementDigest,
} from "../../subscriptions/entitlement-snapshot-reader";
import { lockCurrentGrantOwner, type GrantCredentialIdentity } from "./credential-epoch";
import {
  computeGrantDeadlines,
  loadApprovedGrantPolicy,
  loadEffectiveGrantPolicy,
} from "./grant-policy";
import { freezeGrantTask, type FrozenGrantTask } from "./frozen-task";
import { allowedNativeCapabilities, grantPoolDenial, lockGrantFacts } from "./grant-admission";
import {
  GRANT_SIGNING_CONFIGURATION,
  signOfflineGrant,
  type GrantSigningConfiguration,
} from "./grant-keyset";
export const GRANT_CLOCK = Symbol("GRANT_CLOCK");
type TaskReference = Pick<FrozenGrantTask, "taskKind" | "taskId">;
type DenialReason = Extract<GrantIssueResult, { status: "denied" }>["reason"];
@Injectable()
export class GrantIssuerService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly entitlements: EntitlementsService,
    @Inject(GRANT_SIGNING_CONFIGURATION) private readonly signing: GrantSigningConfiguration | null,
    @Optional() @Inject(GRANT_CLOCK) private readonly clock: () => number = Date.now,
  ) {}
  issueDevice(identity: GrantCredentialIdentity, requestId: string): Promise<GrantIssueResult> {
    return this.issue(identity, requestId, null);
  }
  issueTask(
    identity: GrantCredentialIdentity,
    task: TaskReference,
    requestId: string,
  ): Promise<GrantIssueResult> {
    return this.issue(identity, requestId, task);
  }
  async keyset(identity: GrantCredentialIdentity) {
    return this.db.transaction(async (tx) => {
      if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
        throw new UnauthorizedException();
      return (
        this.signing?.keyset ?? {
          status: "denied" as const,
          reason: "policy_not_configured" as const,
        }
      );
    });
  }
  /** Current authenticated recovery state, independently of new productive entitlement. */
  async configuration(identity: GrantCredentialIdentity): Promise<GrantConfiguration> {
    return this.db.transaction(async (tx) => {
      const owner = await lockCurrentGrantOwner(tx, identity, this.clock());
      if (!owner) throw new UnauthorizedException();
      const current = await this.entitlements.resolveRecovery(
        owner.tenantId,
        tx,
        new Date(this.clock()),
      );
      const effective = current.subscription
        ? await loadEffectiveGrantPolicy(tx, owner, current.subscription.id)
        : { policy: null, activationId: null, basePolicyId: null };
      if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
        throw new UnauthorizedException();
      const configuration = await resolveGrantRollout(
        tx,
        owner,
        effective.policy,
        this.signing !== null,
        effective.activationId,
      );
      if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
        throw new UnauthorizedException();
      return {
        protocol: "offline-grants-v1",
        owner,
        serverTime: this.clock(),
        mode: configuration.mode,
        policyRevision: configuration.policyRevision,
        keyset: this.signing?.keyset ?? null,
      };
    });
  }
  /** Shared negotiated reservation fence. No caller-selected owner or separate pool transaction. */
  async reserve(
    identity: GrantCredentialIdentity,
    requestId: string,
    action: (
      tx: SubscriptionTransaction,
      owner: GrantOwner,
      policy: NonNullable<Awaited<ReturnType<typeof loadApprovedGrantPolicy>>>,
    ) => Promise<KioskGrantReservationResult>,
  ): Promise<KioskGrantReservationResult | GrantIssueResult> {
    return this.db.transaction(
      async (tx) => {
        await lockGrantFacts(tx, identity.tenantId, this.entitlements, true);
        const owner = await lockCurrentGrantOwner(tx, identity, this.clock());
        if (!owner) throw new UnauthorizedException();
        const facts = await this.facts(tx, owner);
        if (facts.status === "denied") {
          await this.audit(
            tx,
            owner,
            "reservation",
            requestId,
            null,
            facts.reason,
            facts.auditContext.revision,
            facts.auditContext.policyRevision,
          );
          return { status: "denied", reason: facts.reason };
        }
        if (owner.kind !== "kiosk" || !facts.capabilities.includes("pickup.start.v1")) {
          await this.audit(
            tx,
            owner,
            "reservation",
            requestId,
            null,
            "not_entitled",
            facts.revision,
            facts.policy.revision,
          );
          return { status: "denied", reason: "not_entitled" };
        }
        const result = await action(tx, owner, facts.policy);
        if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
          throw new UnauthorizedException();
        const final = await this.facts(tx, owner);
        if (
          final.status === "denied" ||
          final.policy.revision !== facts.policy.revision ||
          final.revision !== facts.revision
        )
          throw new ConflictException({ code: "GRANT_ADMISSION_CHANGED" });
        await this.audit(
          tx,
          owner,
          "reservation",
          requestId,
          result.status === "reserved" ? result.task.taskId : null,
          result.status === "denied" ? result.reason : null,
          final.revision,
          final.policy.revision,
        );
        if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
          throw new UnauthorizedException();
        if (this.clock() >= final.deadlines.startNotAfter)
          throw new ConflictException({ code: "GRANT_ADMISSION_CHANGED" });
        return result;
      },
      { isolationLevel: "read committed" },
    );
  }
  private async facts(tx: SubscriptionTransaction, owner: GrantOwner) {
    const now = this.clock(),
      at = new Date(now);
    const facts = await this.entitlements.resolveSnapshotInTransaction(owner.tenantId, tx, at);
    const subscription = facts.snapshot.current.subscription;
    const effective = subscription
      ? await loadEffectiveGrantPolicy(tx, owner, subscription.id)
      : { policy: null, activationId: null, basePolicyId: null };
    const policy = effective.policy;
    const auditContext = {
      revision: `${facts.snapshot.revision}:${facts.snapshot.usageRevision}`,
      activationId: effective.activationId,
      policyRevision: policy?.revision ?? null,
    };
    const denial = (reason: DenialReason) => ({ status: "denied" as const, reason, auditContext });
    if (!this.signing || !policy) return denial("policy_not_configured");
    const capabilities = allowedNativeCapabilities(facts.snapshot, owner);
    if (!capabilities.length) return denial("not_entitled");
    const denied = await grantPoolDenial(tx, owner, facts.snapshot, this.entitlements, at);
    if (denied) return denial(denied);
    const deadlines = computeGrantDeadlines({
      now,
      policy,
      entitlementBoundary: facts.snapshot.nextChangeAt
        ? Date.parse(facts.snapshot.nextChangeAt)
        : null,
    });
    if (deadlines.status === "denied") return denial(deadlines.reason);
    return {
      status: "ready" as const,
      now,
      policy,
      capabilities,
      deadlines,
      snapshot: facts.snapshot,
      auditContext,
      revision: `${facts.snapshot.revision}:${facts.snapshot.usageRevision}`,
      activationId: effective.activationId,
    };
  }
  private async issue(
    identity: GrantCredentialIdentity,
    requestId: string,
    task: TaskReference | null,
  ): Promise<GrantIssueResult> {
    const operation = task ? "task" : "device";
    const result = await this.db.transaction(
      async (tx) => {
        await lockGrantFacts(tx, identity.tenantId, this.entitlements);
        const owner = await lockCurrentGrantOwner(tx, identity, this.clock());
        if (!owner) throw new UnauthorizedException();
        const requestIdentity = entitlementDigest({ owner, operation, requestId });
        const initial = await this.facts(tx, owner);
        let auditContext = initial.auditContext;
        const deny = async (reason: DenialReason): Promise<GrantIssueResult> => {
          await this.audit(
            tx,
            owner,
            operation,
            requestId,
            task?.taskId ?? null,
            reason,
            auditContext.revision,
            auditContext.policyRevision,
          );
          return { status: "denied", reason };
        };
        if (initial.status === "denied") return deny(initial.reason);
        const capability: GrantCapability | null = task
          ? task.taskKind === "shift"
            ? "shift.start.v1"
            : task.taskKind === "inventory"
              ? "inventory.start.v1"
              : "pickup.start.v1"
          : null;
        if (capability && !initial.capabilities.includes(capability)) return deny("not_entitled");
        const [saved] = await tx
          .select()
          .from(schema.deviceGrantIssuances)
          .where(
            and(
              eq(schema.deviceGrantIssuances.tenantId, owner.tenantId),
              eq(schema.deviceGrantIssuances.requestIdentity, requestIdentity),
            ),
          );
        if (saved) {
          const source = saved.taskSourceId
            ? await this.source(tx, owner.tenantId, saved.taskSourceId)
            : null;
          if (
            task &&
            (!source || source.taskKind !== task.taskKind || source.taskId !== task.taskId)
          ) {
            await this.audit(
              tx,
              owner,
              operation,
              requestId,
              task.taskId,
              "task_not_frozen",
              auditContext.revision,
              auditContext.policyRevision,
            );
            return { conflict: true as const };
          }
          if (this.signing?.keyset.retiredKids.includes(saved.headerKid))
            return deny("not_entitled");
          if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
            throw new UnauthorizedException();
          const final = await this.facts(tx, owner);
          auditContext = final.auditContext;
          if (final.status === "denied") return deny(final.reason);
          await this.audit(
            tx,
            owner,
            operation,
            requestId,
            saved.grantId,
            null,
            saved.entitlementRevision,
            saved.policyRevision,
            true,
          );
          const rollout = await resolveGrantRollout(
            tx,
            owner,
            final.policy,
            this.signing !== null,
            final.activationId,
          );
          if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
            throw new UnauthorizedException();
          if (this.clock() >= final.deadlines.startNotAfter)
            throw new ConflictException({ code: "GRANT_ADMISSION_CHANGED" });
          return {
            status: "issued" as const,
            envelope: this.envelope(
              owner,
              saved.compactJws,
              source ? [this.binding(source)] : [],
              rollout.mode,
            ),
          };
        }
        const frozen = task ? await freezeGrantTask(tx, owner, task, initial.policy) : null;
        if (frozen?.status === "denied") return deny(frozen.reason);
        if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
          throw new UnauthorizedException();
        const final = await this.facts(tx, owner);
        auditContext = final.auditContext;
        if (final.status === "denied") return deny(final.reason);
        if (
          final.policy.revision !== initial.policy.revision ||
          final.revision !== initial.revision ||
          (capability && !final.capabilities.includes(capability))
        )
          return deny("facts_unknown");
        if (
          frozen?.status === "ready" &&
          frozen.task.eventTypes.includes("shift.pallet.close.v1") &&
          evaluateEntitlementOperation(final.snapshot, "pallets.shift.start.v1").outcome !== "allow"
        )
          return deny("not_entitled");
        if (!this.signing) return deny("policy_not_configured");
        const base = {
          ...owner,
          version: 1 as const,
          issuer: this.signing.origin,
          grantId: randomUUID(),
          entitlementRevision: final.revision,
          policyRevision: final.policy.revision,
          issuedAt: final.now,
          notBefore: final.now,
        };
        const payload: OfflineGrant =
          frozen?.status === "ready"
            ? {
                ...base,
                ...frozen.task,
                kindOfGrant: "task",
                completeNotAfter: final.deadlines.completeNotAfter,
              }
            : {
                ...base,
                kindOfGrant: "device",
                capabilities: final.capabilities,
                startNotAfter: final.deadlines.startNotAfter,
              };
        const compactJws = signOfflineGrant(this.signing, payload);
        const source =
          frozen?.status === "ready"
            ? await this.source(tx, owner.tenantId, frozen.sourceId)
            : null;
        const taskSnapshots = source ? [this.binding(source)] : [];
        await tx.insert(schema.deviceGrantIssuances).values({
          grantId: payload.grantId,
          tenantId: owner.tenantId,
          ownerKind: owner.kind,
          stationDeviceId: owner.kind === "kiosk" ? null : owner.deviceId,
          kioskId: owner.kind === "kiosk" ? owner.deviceId : null,
          credentialEpoch: owner.credentialEpoch,
          kindOfGrant: payload.kindOfGrant,
          taskSourceId: source?.id ?? null,
          policyId: final.policy.id,
          policyRevision: payload.policyRevision,
          entitlementRevision: payload.entitlementRevision,
          requestIdentity,
          headerKid: this.signing.kid,
          compactJws,
          payloadDigest: createHash("sha256")
            .update(Buffer.from(compactJws.split(".")[1] ?? "", "base64url"))
            .digest("hex"),
          issuedAt: new Date(payload.issuedAt),
          startNotAfter: payload.kindOfGrant === "device" ? new Date(payload.startNotAfter) : null,
          completeNotAfter:
            payload.kindOfGrant === "task" ? new Date(payload.completeNotAfter) : null,
        });
        await this.audit(
          tx,
          owner,
          operation,
          requestId,
          payload.grantId,
          null,
          payload.entitlementRevision,
          payload.policyRevision,
        );
        const rollout = await resolveGrantRollout(
          tx,
          owner,
          final.policy,
          this.signing !== null,
          final.activationId,
        );
        if (!(await lockCurrentGrantOwner(tx, identity, this.clock())))
          throw new UnauthorizedException();
        if (this.clock() >= final.deadlines.startNotAfter)
          throw new ConflictException({ code: "GRANT_ADMISSION_CHANGED" });
        return {
          status: "issued" as const,
          envelope: this.envelope(owner, compactJws, taskSnapshots, rollout.mode),
        };
      },
      { isolationLevel: "read committed" },
    );
    if ("conflict" in result) throw new ConflictException({ code: "GRANT_REQUEST_CONFLICT" });
    return result;
  }
  private async source(tx: SubscriptionTransaction, tenantId: string, id: string) {
    const [source] = await tx
      .select()
      .from(schema.deviceGrantTaskSources)
      .where(
        and(
          eq(schema.deviceGrantTaskSources.tenantId, tenantId),
          eq(schema.deviceGrantTaskSources.id, id),
        ),
      );
    if (!source) throw new Error("Frozen grant provenance missing");
    return source;
  }
  private binding(source: typeof schema.deviceGrantTaskSources.$inferSelect): GrantTaskSnapshot {
    const canonical = entitlementCanonical({
      taskKind: source.taskKind,
      taskId: source.taskId,
      scope: source.scope,
    });
    if (createHash("sha256").update(canonical).digest("hex") !== source.snapshotDigest)
      throw new Error("Frozen grant identity mismatch");
    return {
      taskKind: source.taskKind,
      taskId: source.taskId,
      snapshotDigest: source.snapshotDigest,
      canonical,
    };
  }
  private envelope(
    owner: GrantOwner,
    compact: string,
    taskSnapshots: GrantTaskSnapshot[],
    mode: "observe" | "strict",
  ): GrantEnvelope {
    return {
      protocol: "offline-grants-v1",
      serverTime: this.clock(),
      owner,
      mode,
      grants: [compact],
      taskSnapshots,
    };
  }
  private audit(
    tx: SubscriptionTransaction,
    owner: GrantOwner,
    operation: string,
    requestId: string,
    targetId: string | null,
    reason: DenialReason | null,
    entitlementRevision: string | null = null,
    policyRevision: string | null = null,
    replay = false,
  ) {
    return tx.insert(schema.tenantAuditEvents).values({
      organizationId: owner.tenantId,
      actorUserId: null,
      action: `offline_grant.${operation}.${reason ? "denied" : replay ? "replayed" : "issued"}`,
      outcome: reason ? "failure" : "success",
      targetType: "offline_grant",
      targetId,
      requestId,
      after: {
        actorDomain: owner.kind === "kiosk" ? "kiosk_device" : "station_device",
        actorId: owner.deviceId,
        deviceKind: owner.kind,
        credentialEpoch: owner.credentialEpoch,
        operation,
        reason,
        entitlementRevision,
        policyRevision,
      },
    });
  }
}
