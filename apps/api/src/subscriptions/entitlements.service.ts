import type { EntitlementSnapshotV1 } from "@markiro/platform-contracts";
import { countWorkingDeviceUsage } from "./working-device-assignments";
import { projectEntitlements } from "./entitlement-projection";
import {
  readEntitlementFacts,
  entitlementDigest,
  loadEntitlementTimeline,
  type EntitlementTimeline,
} from "./entitlement-snapshot-reader";
import { NationalCatalogCapabilitiesService } from "../modules/national-catalog/national-catalog-capabilities.service";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Db } from "@markiro/db";
import { DB } from "../auth/auth.module";
import {
  SubscriptionEntitlementsInvalidException,
  SubscriptionFeatureDisabledException,
  SubscriptionLimitReachedException,
  SubscriptionReadOnlyException,
  SubscriptionUnmanagedException,
} from "./subscription-errors";
import {
  type EffectiveEntitlements,
  type EntitlementContributor,
  type EntitlementsExecutor,
  type EntitlementUsage,
  type FeatureEntitlementKey,
  QUANTITATIVE_ENTITLEMENT_KEYS,
  type QuantitativeEntitlementKey,
  type SubscriptionEnforcementMode,
  type SubscriptionAccessSnapshot,
  type SubscriptionTransaction,
  subscriptionQuotaLockIdentity,
} from "./entitlements.types";

export const SUBSCRIPTION_ENFORCEMENT_MODE = Symbol("SUBSCRIPTION_ENFORCEMENT_MODE");

const ZERO_QUOTAS = {
  lines: 0,
  stations: 0,
  kiosks: 0,
  cabinetUsers: 0,
} satisfies EffectiveEntitlements["quotas"];
const DISABLED_FEATURES = {
  labelEditor: false,
  publicApi: false,
  pallets: false,
} satisfies EffectiveEntitlements["features"];

type SubscriptionRow = typeof schema.tenantSubscriptions.$inferSelect;

@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(SUBSCRIPTION_ENFORCEMENT_MODE)
    private readonly enforcementMode: SubscriptionEnforcementMode,
    @Optional() private readonly nationalCatalog?: NationalCatalogCapabilitiesService,
  ) {}

  async resolveSnapshot(tenantId: string): Promise<EntitlementSnapshotV1> {
    const { snapshot } = await this.db.transaction(
      (tx) => this.resolveSnapshotInTransaction(tenantId, tx),
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
    return this.observeConnectivity(snapshot);
  }

  /** Internal operation-owner entry; caller owns coherent isolation and all locks. */
  async resolveSnapshotInTransaction(
    tenantId: string,
    tx: SubscriptionTransaction,
    at = new Date(),
    timeline?: EntitlementTimeline,
    baseUsage?: EntitlementUsage,
  ) {
    const current = await this.resolve(tenantId, tx, at, timeline);
    const usage =
      baseUsage && timeline
        ? {
            ...baseUsage,
            cabinetUsers:
              baseUsage.cabinetUsers +
              timeline.invitations.filter((row) => row.expiresAt > at).length,
          }
        : await this.usage(tenantId, tx, at);
    const facts = await readEntitlementFacts(tx, current, timeline);
    const input = { current, usage, at, enforcementMode: this.enforcementMode, ...facts };
    return {
      ...facts,
      input,
      snapshot: projectEntitlements(input),
      usageFingerprint: entitlementDigest(usage),
    };
  }

  async loadSnapshotTimeline(
    tenantId: string,
    tx: SubscriptionTransaction,
    loaded?: EntitlementTimeline,
  ) {
    const timeline = loaded ?? (await loadEntitlementTimeline(tx, tenantId));
    const at = new Date();
    const usage = await this.usage(tenantId, tx, at, timeline.invitations);
    usage.cabinetUsers -= timeline.invitations.filter((row) => row.expiresAt > at).length;
    return (at: Date) => this.resolveSnapshotInTransaction(tenantId, tx, at, timeline, usage);
  }

  async observeConnectivity(snapshot: EntitlementSnapshotV1): Promise<EntitlementSnapshotV1> {
    const connectivity: EntitlementSnapshotV1["connectivity"] = {
      observedAt: new Date().toISOString(),
      chz: "unknown",
      nationalCatalog: "unknown",
    };
    if (this.nationalCatalog) {
      try {
        Object.assign(
          connectivity,
          await this.nationalCatalog.observeEntitlementConnectivity(snapshot.tenantId),
        );
      } catch {
        /* Observation unavailable, never a grant. */
      }
    }
    return { ...snapshot, connectivity };
  }

  async resolve(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
    timeline?: EntitlementTimeline,
  ): Promise<EffectiveEntitlements> {
    const subscriptions =
      timeline?.subscriptions ??
      (await executor
        .select()
        .from(schema.tenantSubscriptions)
        .where(eq(schema.tenantSubscriptions.tenantId, tenantId))
        .orderBy(asc(schema.tenantSubscriptions.createdAt), asc(schema.tenantSubscriptions.id)));

    if (subscriptions.length === 0) {
      return {
        tenantId,
        access: "unmanaged",
        subscription: null,
        quotas: { lines: null, stations: null, kiosks: null, cabinetUsers: null },
        features: { labelEditor: true, publicApi: true, pallets: true },
      };
    }

    const effective = subscriptions.filter((row) => isEffectiveAt(row, at));
    if (effective.length > 1) throw new SubscriptionEntitlementsInvalidException();
    const selected = effective[0];
    if (selected) {
      const plan = await this.planEntitlements(executor, selected.planVersionId, timeline);
      const contributors = await this.contributorsFor(
        executor,
        tenantId,
        selected.id,
        at,
        timeline,
      );
      return {
        tenantId,
        access: "managed",
        subscription: {
          id: selected.id,
          planVersionId: selected.planVersionId,
          status: selected.status === "trial" ? "trial" : "active",
          startsAt: selected.startsAt,
          endsAt: selected.endsAt,
        },
        quotas: addQuotas(plan.quotas, contributors),
        features: addFeatures(plan.features, contributors),
      };
    }

    const pending = subscriptions.filter((row) => row.status === "pending_activation");
    if (pending.length > 1) throw new SubscriptionEntitlementsInvalidException();
    if (pending[0]) {
      await this.planEntitlements(executor, pending[0].planVersionId, timeline);
      return readOnlyEntitlements(tenantId, pending[0], "pending_activation");
    }

    const ended = subscriptions
      .filter(
        (row) =>
          row.status !== "cancelled" &&
          row.status !== "superseded" &&
          row.endsAt !== null &&
          row.endsAt <= at,
      )
      .sort((left, right) => right.endsAt!.getTime() - left.endsAt!.getTime());
    if (ended[0]) {
      await this.planEntitlements(executor, ended[0].planVersionId, timeline);
      return readOnlyEntitlements(tenantId, ended[0], "expired");
    }

    return {
      tenantId,
      access: "read_only",
      subscription: null,
      quotas: { ...ZERO_QUOTAS },
      features: { ...DISABLED_FEATURES },
    };
  }

  async usage(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
    pendingInvitations?: EntitlementTimeline["invitations"],
  ): Promise<EntitlementUsage> {
    const [lines] = await executor
      .select({ value: count() })
      .from(schema.lines)
      .where(eq(schema.lines.tenantId, tenantId));
    const stations = await countWorkingDeviceUsage(executor, tenantId);
    const [kiosks] = await executor
      .select({ value: count() })
      .from(schema.kiosks)
      .where(and(eq(schema.kiosks.tenantId, tenantId), eq(schema.kiosks.status, "active")));
    const [members] = await executor
      .select({ value: count() })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId));
    const [invitations] = pendingInvitations
      ? [{ value: pendingInvitations.filter((row) => row.expiresAt > at).length }]
      : await executor
          .select({ value: count() })
          .from(schema.invitation)
          .where(
            and(
              eq(schema.invitation.organizationId, tenantId),
              eq(schema.invitation.status, "pending"),
              gt(schema.invitation.expiresAt, at),
            ),
          );
    return {
      lines: lines?.value ?? 0,
      stations,
      kiosks: kiosks?.value ?? 0,
      cabinetUsers: (members?.value ?? 0) + (invitations?.value ?? 0),
    };
  }

  async resolveRecovery(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
  ): Promise<EffectiveEntitlements> {
    const resolved = await this.resolve(tenantId, executor, at);
    if (resolved.access === "unmanaged" && this.enforcementMode === "all") {
      throw new SubscriptionUnmanagedException();
    }
    return resolved;
  }

  async assertWriteAccess(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
  ): Promise<EffectiveEntitlements> {
    const resolved = await this.resolveRecovery(tenantId, executor, at);
    if (resolved.access === "read_only") throw new SubscriptionReadOnlyException();
    return resolved;
  }

  async assertFeatureAccess(
    tenantId: string,
    key: FeatureEntitlementKey,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
  ): Promise<EffectiveEntitlements> {
    const resolved = await this.assertWriteAccess(tenantId, executor, at);
    if (!resolved.features[key]) throw new SubscriptionFeatureDisabledException(key);
    return resolved;
  }

  async accessSnapshot(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
  ): Promise<SubscriptionAccessSnapshot> {
    const resolved = await this.resolve(tenantId, executor, at);
    return this.snapshotFrom(resolved);
  }

  snapshotFrom(resolved: EffectiveEntitlements): SubscriptionAccessSnapshot {
    return {
      access: resolved.access,
      status:
        resolved.access === "unmanaged"
          ? "unmanaged"
          : (resolved.subscription?.status ?? "read_only"),
      startsAt: resolved.subscription?.startsAt?.toISOString() ?? null,
      endsAt: resolved.subscription?.endsAt?.toISOString() ?? null,
    };
  }

  async contributors(
    tenantId: string,
    executor: EntitlementsExecutor = this.db,
    at = new Date(),
  ): Promise<EntitlementContributor[]> {
    const resolved = await this.resolve(tenantId, executor, at);
    if (!resolved.subscription || resolved.access !== "managed") return [];
    return this.contributorsFor(executor, tenantId, resolved.subscription.id, at);
  }

  async withQuotaSlot<T>(
    tx: SubscriptionTransaction,
    tenantId: string,
    key: QuantitativeEntitlementKey,
    create: () => Promise<T>,
  ): Promise<T> {
    return this.withQuotaLock(tx, tenantId, key, async () => {
      const at = new Date();
      const entitlements = await this.resolve(tenantId, tx, at);
      if (entitlements.access === "unmanaged") {
        if (this.enforcementMode === "all") throw new SubscriptionUnmanagedException();
        return create();
      }
      const usage = await this.usage(tenantId, tx, at);
      const limit = entitlements.quotas[key];
      if (limit !== null && usage[key] >= limit) {
        throw new SubscriptionLimitReachedException(key, usage[key], limit);
      }
      return create();
    });
  }

  async withQuotaLock<T>(
    tx: SubscriptionTransaction,
    tenantId: string,
    key: QuantitativeEntitlementKey,
    action: () => Promise<T>,
  ): Promise<T> {
    const lock = subscriptionQuotaLockIdentity(tenantId, key);
    // All quota locks use the same namespace and numeric key order. A caller
    // needing more than one must acquire them in QUANTITATIVE_ENTITLEMENT_KEYS
    // order, preventing line/station/kiosk/seat lock-order inversions.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${lock.namespace}), ${lock.keyOrder})`,
    );
    return action();
  }

  private async planEntitlements(
    executor: EntitlementsExecutor,
    versionId: string,
    timeline?: EntitlementTimeline,
  ) {
    const [row] = timeline
      ? timeline.plans.filter(
          (plan) =>
            plan.catalogVersionId === versionId &&
            timeline.versions.some(
              (version) =>
                version.id === versionId &&
                version.kind === "plan" &&
                ["published", "retired"].includes(version.status),
            ),
        )
      : await executor
          .select({
            versionId: schema.catalogItemVersions.id,
            maxLines: schema.planEntitlements.maxLines,
            maxStations: schema.planEntitlements.maxStations,
            maxKiosks: schema.planEntitlements.maxKiosks,
            maxCabinetUsers: schema.planEntitlements.maxCabinetUsers,
            labelEditorEnabled: schema.planEntitlements.labelEditorEnabled,
            publicApiEnabled: schema.planEntitlements.publicApiEnabled,
            palletsEnabled: schema.planEntitlements.palletsEnabled,
          })
          .from(schema.catalogItemVersions)
          .innerJoin(
            schema.planEntitlements,
            eq(schema.planEntitlements.catalogVersionId, schema.catalogItemVersions.id),
          )
          .where(
            and(
              eq(schema.catalogItemVersions.id, versionId),
              eq(schema.catalogItemVersions.kind, "plan"),
              inArray(schema.catalogItemVersions.status, ["published", "retired"]),
            ),
          )
          .limit(1);
    if (!row) throw new SubscriptionEntitlementsInvalidException();
    return {
      quotas: {
        lines: row.maxLines,
        stations: row.maxStations,
        kiosks: row.maxKiosks,
        cabinetUsers: row.maxCabinetUsers,
      } satisfies EffectiveEntitlements["quotas"],
      features: {
        labelEditor: row.labelEditorEnabled,
        publicApi: row.publicApiEnabled,
        pallets: row.palletsEnabled,
      } satisfies EffectiveEntitlements["features"],
    };
  }

  private async contributorsFor(
    executor: EntitlementsExecutor,
    tenantId: string,
    subscriptionId: string,
    at: Date,
    timeline?: EntitlementTimeline,
  ): Promise<EntitlementContributor[]> {
    const addons = timeline
      ? timeline.additions
          .filter(
            (row) =>
              row.subscriptionId === subscriptionId &&
              ["active", "scheduled"].includes(row.status) &&
              (row.startsAt === null || row.startsAt <= at) &&
              (row.endsAt === null || row.endsAt > at),
          )
          .map((row) => ({ ...row, versionId: row.addonVersionId }))
      : await executor
          .select({
            id: schema.subscriptionAddons.id,
            versionId: schema.subscriptionAddons.addonVersionId,
            quantity: schema.subscriptionAddons.quantity,
            status: schema.subscriptionAddons.status,
            startsAt: schema.subscriptionAddons.startsAt,
          })
          .from(schema.subscriptionAddons)
          .where(
            and(
              eq(schema.subscriptionAddons.tenantId, tenantId),
              eq(schema.subscriptionAddons.subscriptionId, subscriptionId),
              inArray(schema.subscriptionAddons.status, ["active", "scheduled"]),
              or(
                isNull(schema.subscriptionAddons.startsAt),
                sql`${schema.subscriptionAddons.startsAt} <= ${at}`,
              ),
              or(
                isNull(schema.subscriptionAddons.endsAt),
                gt(schema.subscriptionAddons.endsAt, at),
              ),
            ),
          )
          .orderBy(asc(schema.subscriptionAddons.id));

    const contributors: EntitlementContributor[] = [];
    for (const addon of addons) {
      if (addon.status === "scheduled" && addon.startsAt === null) {
        throw new SubscriptionEntitlementsInvalidException();
      }
      const [version] = timeline
        ? timeline.versions.filter(
            (row) =>
              row.id === addon.versionId &&
              row.kind === "addon" &&
              ["published", "retired"].includes(row.status),
          )
        : await executor
            .select({ id: schema.catalogItemVersions.id })
            .from(schema.catalogItemVersions)
            .where(
              and(
                eq(schema.catalogItemVersions.id, addon.versionId),
                eq(schema.catalogItemVersions.kind, "addon"),
                inArray(schema.catalogItemVersions.status, ["published", "retired"]),
              ),
            )
            .limit(1);
      if (!version) throw new SubscriptionEntitlementsInvalidException();
      const effects = timeline
        ? timeline.effects.filter((row) => row.catalogVersionId === addon.versionId)
        : await executor
            .select()
            .from(schema.addonEntitlements)
            .where(eq(schema.addonEntitlements.catalogVersionId, addon.versionId))
            .orderBy(asc(schema.addonEntitlements.entitlementKey));
      if (effects.length === 0) throw new SubscriptionEntitlementsInvalidException();
      const quotas: Partial<Record<QuantitativeEntitlementKey, number>> = {};
      const features: FeatureEntitlementKey[] = [];
      for (const effect of effects) {
        if (isQuantitativeKey(effect.entitlementKey)) {
          if (effect.quotaIncrement === null) throw new SubscriptionEntitlementsInvalidException();
          const value = effect.quotaIncrement * addon.quantity;
          if (!Number.isSafeInteger(value) || value <= 0) {
            throw new SubscriptionEntitlementsInvalidException();
          }
          quotas[effect.entitlementKey] = value;
        } else {
          if (!effect.featureEnabled) throw new SubscriptionEntitlementsInvalidException();
          if (
            effect.entitlementKey === "labelEditor" ||
            effect.entitlementKey === "publicApi" ||
            effect.entitlementKey === "pallets"
          ) {
            features.push(effect.entitlementKey);
          }
        }
      }
      contributors.push({
        subscriptionAddonId: addon.id,
        catalogVersionId: addon.versionId,
        quantity: addon.quantity,
        quotas,
        features,
      });
    }
    return contributors;
  }
}

function isEffectiveAt(row: SubscriptionRow, at: Date): boolean {
  if (!inCandidateStatus(row.status)) return false;
  if (row.status === "scheduled" && row.startsAt === null) return false;
  return (row.startsAt === null || row.startsAt <= at) && (row.endsAt === null || row.endsAt > at);
}

function inCandidateStatus(status: SubscriptionRow["status"]): boolean {
  return status === "trial" || status === "active" || status === "scheduled";
}

function readOnlyEntitlements(
  tenantId: string,
  row: SubscriptionRow,
  status: "pending_activation" | "expired",
): EffectiveEntitlements {
  return {
    tenantId,
    access: "read_only",
    subscription: {
      id: row.id,
      planVersionId: row.planVersionId,
      status,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
    },
    quotas: { ...ZERO_QUOTAS },
    features: { ...DISABLED_FEATURES },
  };
}

function addQuotas(
  base: EffectiveEntitlements["quotas"],
  contributors: EntitlementContributor[],
): EffectiveEntitlements["quotas"] {
  const result = { ...base };
  for (const contributor of contributors) {
    for (const key of QUANTITATIVE_ENTITLEMENT_KEYS) {
      const increment = contributor.quotas[key];
      if (increment === undefined || result[key] === null) continue;
      const value = result[key] + increment;
      if (!Number.isSafeInteger(value)) throw new SubscriptionEntitlementsInvalidException();
      result[key] = value;
    }
  }
  return result;
}

function addFeatures(
  base: EffectiveEntitlements["features"],
  contributors: EntitlementContributor[],
): EffectiveEntitlements["features"] {
  const result = { ...base };
  for (const contributor of contributors) {
    for (const key of contributor.features) result[key] = true;
  }
  return result;
}

function isQuantitativeKey(value: string): value is QuantitativeEntitlementKey {
  return (QUANTITATIVE_ENTITLEMENT_KEYS as readonly string[]).includes(value);
}
