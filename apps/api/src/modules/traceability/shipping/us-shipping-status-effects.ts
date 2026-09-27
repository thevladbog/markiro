import { schema } from "@markiro/db";
import type { ShippingBalance } from "@markiro/domain";
import { ServiceUnavailableException } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { UsMasterDataTransaction } from "../master-data/us-master-data-support";
import { lotResponse } from "../lots/us-lot-support";

const unavailable = () => new ServiceUnavailableException({ code: "us_database_unavailable" });
const lots = schema.traceabilityLots;
const effects = schema.shippingLotStatusEffects;
const DECIMAL = /^(0|[1-9]\d{0,14})(?:\.(\d{1,3}))?$/;

function positive(value: string): boolean {
  const match = DECIMAL.exec(value);
  return !!match && (match[1] !== "0" || /[1-9]/.test(match[2] ?? ""));
}

/** Required for exact, same-transaction audit of every automatic lot transition. */
export type ShippingStatusAuditContext = {
  actorUserId: string;
  requestId: string;
  reason: string;
};

async function lockedLot(tx: UsMasterDataTransaction, tenantId: string, lotId: string) {
  const [lot] = await tx
    .select()
    .from(lots)
    .where(and(eq(lots.tenantId, tenantId), eq(lots.id, lotId)))
    .for("update");
  if (!lot) throw unavailable();
  return lot;
}

async function audit(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  eventId: string,
  before: ReturnType<typeof lotResponse>,
  after: ReturnType<typeof lotResponse>,
  context: ShippingStatusAuditContext,
  ownerEventId?: string,
) {
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: tenantId,
    actorUserId: context.actorUserId,
    action: "traceability.lot.status_changed",
    outcome: "success",
    targetType: "traceability_lot",
    targetId: lotId,
    before: ownerEventId ? { ...before, eventId: ownerEventId } : before,
    after: {
      ...after,
      reason: context.reason,
      eventId,
      ...(ownerEventId ? { ownerEventId, initiatingEventId: eventId } : {}),
      origin: "shipping",
    },
    requestId: context.requestId,
  });
}

/** Caller locks affected lots in sorted UUID order before this operation. */
export async function applyShippingStatusEffect(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  eventId: string,
  balance: ShippingBalance,
  context: ShippingStatusAuditContext,
): Promise<void> {
  if (balance.state !== "known" || balance.remaining !== "0" || balance.supply === "0") return;
  const lot = await lockedLot(tx, tenantId, lotId);
  if (lot.status !== "active") return;
  const [existing] = await tx
    .select({ id: effects.id })
    .from(effects)
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.lotId, lotId), isNull(effects.compensatedAt)),
    )
    .limit(1);
  if (existing) throw unavailable();
  const now = new Date();
  await tx.insert(effects).values({
    tenantId,
    eventId,
    lotId,
    priorStatus: "active",
    newStatus: "shipped",
  });
  const [updated] = await tx
    .update(lots)
    .set({
      status: "shipped",
      revision: lot.revision + 1,
      lastStatusReason: context.reason,
      lastSourceReason: null,
      updatedBy: context.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(lots.tenantId, tenantId),
        eq(lots.id, lotId),
        eq(lots.status, "active"),
        eq(lots.revision, lot.revision),
      ),
    )
    .returning();
  if (!updated) throw unavailable();
  await audit(tx, tenantId, lotId, eventId, lotResponse(lot), lotResponse(updated), context);
}

/** Manual status commands call this while holding the same lot row lock. */
export async function invalidateShippingStatusEffect(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  reason: string,
): Promise<void> {
  await tx
    .update(effects)
    .set({ compensatedAt: new Date(), compensationReason: reason })
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.lotId, lotId), isNull(effects.compensatedAt)),
    );
}

/** A void/amend may release another event's ownership when the lot balance becomes positive. */
export async function compensateShippingStatusEffect(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  initiatingEventId: string,
  balance: ShippingBalance,
  context: ShippingStatusAuditContext,
): Promise<void> {
  const lot = await lockedLot(tx, tenantId, lotId);
  const [effect] = await tx
    .select()
    .from(effects)
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.lotId, lotId), isNull(effects.compensatedAt)),
    )
    .limit(1);
  if (!effect) return;
  // Equal-net amendments, unknown evidence, and non-positive balances do not
  // release a still-shipped lot's owner. A later positive recalculation may.
  const reopen = balance.state === "known" && positive(balance.remaining);
  if (lot.status === "shipped" && !reopen) return;
  const now = new Date();
  const [closed] = await tx
    .update(effects)
    .set({ compensatedAt: now, compensationReason: context.reason })
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.id, effect.id), isNull(effects.compensatedAt)),
    )
    .returning();
  if (!closed) throw unavailable();
  if (lot.status !== "shipped") {
    await tx.insert(schema.tenantAuditEvents).values({
      organizationId: tenantId,
      actorUserId: context.actorUserId,
      action: "traceability.shipping.status_effect_compensated",
      outcome: "success",
      targetType: "shipping_status_effect",
      targetId: effect.id,
      before: { lotId, eventId: effect.eventId, status: lot.status, owned: true },
      after: {
        lotId,
        eventId: initiatingEventId,
        ownerEventId: effect.eventId,
        initiatingEventId,
        status: lot.status,
        owned: false,
        balance,
        reason: context.reason,
        result: "status_preserved",
      },
      requestId: context.requestId,
    });
    return;
  }
  const [updated] = await tx
    .update(lots)
    .set({
      status: "active",
      revision: lot.revision + 1,
      lastStatusReason: context.reason,
      lastSourceReason: null,
      updatedBy: context.actorUserId,
      updatedAt: now,
    })
    .where(
      and(
        eq(lots.tenantId, tenantId),
        eq(lots.id, lotId),
        eq(lots.status, "shipped"),
        eq(lots.revision, lot.revision),
      ),
    )
    .returning();
  if (!updated) throw unavailable();
  await audit(
    tx,
    tenantId,
    lotId,
    initiatingEventId,
    lotResponse(lot),
    lotResponse(updated),
    context,
    effect.eventId,
  );
}

/** A full-to-full amendment replaces the status owner without changing the lot status. */
export async function transferShippingStatusEffect(
  tx: UsMasterDataTransaction,
  tenantId: string,
  lotId: string,
  predecessorEventId: string,
  successorEventId: string,
  balance: ShippingBalance,
  context: ShippingStatusAuditContext,
): Promise<void> {
  if (balance.state !== "known" || balance.remaining !== "0") return;
  const lot = await lockedLot(tx, tenantId, lotId);
  if (lot.status !== "shipped") return;
  const [owner] = await tx
    .select()
    .from(effects)
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.lotId, lotId), isNull(effects.compensatedAt)),
    )
    .limit(1);
  if (!owner || owner.eventId !== predecessorEventId) return;
  const [closed] = await tx
    .update(effects)
    .set({ compensatedAt: new Date(), compensationReason: context.reason })
    .where(
      and(eq(effects.tenantId, tenantId), eq(effects.id, owner.id), isNull(effects.compensatedAt)),
    )
    .returning();
  if (!closed) throw unavailable();
  const [replacement] = await tx
    .insert(effects)
    .values({
      tenantId,
      eventId: successorEventId,
      lotId,
      priorStatus: "active",
      newStatus: "shipped",
    })
    .returning();
  if (!replacement) throw unavailable();
  await tx.insert(schema.tenantAuditEvents).values({
    organizationId: tenantId,
    actorUserId: context.actorUserId,
    action: "traceability.shipping.status_effect_transferred",
    outcome: "success",
    targetType: "shipping_status_effect",
    targetId: replacement.id,
    before: { id: owner.id, eventId: predecessorEventId, lotId, status: lot.status },
    after: {
      id: replacement.id,
      eventId: successorEventId,
      lotId,
      status: lot.status,
      reason: context.reason,
    },
    requestId: context.requestId,
  });
}
