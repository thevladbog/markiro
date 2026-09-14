import { isValidSscc, productLabelValueDigest } from "@markiro/domain";
import {
  grantEvidenceEnvelopeSchema,
  grantEvidenceReceiptSchema,
  type GrantEvidenceEnvelope,
  type GrantEvidenceReceipt,
} from "@markiro/platform-contracts";
import { z } from "zod";
import type { KioskClient } from "../api/client.js";
import type { CreateOrderResultDto } from "../api/types.js";
import type { QueuedOrder } from "../store/queue.js";
import {
  sameBoxRegistryCredentialOwner,
  type BoxRegistryCredentialOwner,
} from "../store/installation-binding.js";
import { STORE_QUEUE, STORE_JOURNAL, STORE_QUARANTINE, STORE_OUTCOMES } from "../store/db.js";
import { pruneJournal } from "../store/journal.js";
import { putOutcomeInTransaction } from "../store/outcomes.js";
import { runChecked, withGrantTransaction, type StoredGrant } from "./store.js";
const sscc = z.string().refine(isValidSscc);
const nativeResultSchema = z
  .object({
    orderNo: z.string(),
    status: z.literal("pending"),
    itemCount: z.number().int().min(0).max(1500),
    conflicts: z.array(
      z
        .object({
          rawKm: z.string(),
          reason: z.enum([
            "not_km",
            "incomplete",
            "unknown_product",
            "not_allowed",
            "duplicate",
            "over_limit",
          ]),
        })
        .strict(),
    ),
    boxConflicts: z
      .array(
        z
          .object({
            sscc,
            bottleCount: z.number().int().min(0).nullable(),
            reason: z.enum([
              "unknown_box",
              "box_not_closed",
              "box_disassembled",
              "box_contents_changed",
              "mixed_product_box",
              "duplicate",
              "over_limit",
            ]),
          })
          .strict(),
      )
      .optional(),
    acceptedBoxes: z
      .array(z.object({ sscc, bottleCount: z.number().int().positive().max(500) }).strict())
      .optional(),
  })
  .strict();
const equalOrder = (a: QueuedOrder, b: QueuedOrder) =>
  a.employeeId === b.employeeId &&
  JSON.stringify(a.body) === JSON.stringify(b.body) &&
  JSON.stringify(a.grantEvidence) === JSON.stringify(b.grantEvidence);
const evidenceKey = (owner: BoxRegistryCredentialOwner, seq: number) =>
  JSON.stringify(["evidence", owner.binding.serverUrl, owner.binding.kioskId, seq]);
async function prepare(
  owner: BoxRegistryCredentialOwner,
  order: QueuedOrder,
): Promise<GrantEvidenceEnvelope | null> {
  let result: GrantEvidenceEnvelope | null = null;
  const batchId = crypto.randomUUID(),
    payloadDigest = productLabelValueDigest(order.body);
  await withGrantTransaction([STORE_QUEUE], (context) => {
    if (!sameBoxRegistryCredentialOwner(context.owner, owner)) return;
    const queue = context.tx.objectStore(STORE_QUEUE),
      request = queue.get(order.deviceSeq);
    request.onsuccess = () =>
      runChecked(context.tx, () => {
        const current = request.result as QueuedOrder | undefined;
        if (!current || !equalOrder(current, order)) return;
        if (current.evidenceEnvelope) {
          result = grantEvidenceEnvelopeSchema.parse(current.evidenceEnvelope);
          if (
            result.payloadDigest !== payloadDigest ||
            JSON.stringify(result.payload) !== JSON.stringify(order.body)
          )
            throw Error("kiosk evidence identity mismatch");
          return;
        }
        const grantId = current.grantEvidence?.taskGrantId;
        const persist = (grants: string[]) => {
          result = grantEvidenceEnvelopeSchema.parse({
            protocol: "offline-grants-v1",
            batchId,
            payloadDigest,
            grants,
            eventGrants: grantId ? { "/#pickup.complete.v1": grantId } : {},
            payload: order.body,
          });
          queue.put({ ...current, evidenceEnvelope: result });
          context.store.put({ owner, envelope: result }, evidenceKey(owner, order.deviceSeq));
        };
        if (!grantId && current.evidenceProtocol === "offline-grants-v1") {
          persist([]);
          return;
        }
        if (!grantId || !context.state?.tenantId)
          throw Error("kiosk evidence original grant unavailable");
        const saved = context.store.get(
          JSON.stringify([
            "grant",
            owner.binding.serverUrl,
            context.state.tenantId,
            owner.binding.kioskId,
            grantId,
          ]),
        );
        saved.onsuccess = () =>
          runChecked(context.tx, () => {
            const archive = saved.result as StoredGrant | undefined;
            if (
              !archive ||
              archive.grant.grantId !== grantId ||
              archive.grant.deviceId !== owner.binding.kioskId ||
              archive.grant.tenantId !== context.state?.tenantId
            )
              throw Error("kiosk evidence original grant unavailable");
            persist([archive.compact]);
          });
      });
  });
  return result;
}
/** A current queue/credential CAS atomically retains receipt, outcome and native acknowledgement. */
async function commit(
  owner: BoxRegistryCredentialOwner,
  order: QueuedOrder,
  envelope: GrantEvidenceEnvelope,
  receipt: GrantEvidenceReceipt,
  native: CreateOrderResultDto | null,
  at: string,
): Promise<boolean> {
  let committed = false;
  await withGrantTransaction(
    [STORE_QUEUE, STORE_JOURNAL, STORE_QUARANTINE, STORE_OUTCOMES],
    (context) => {
      if (!sameBoxRegistryCredentialOwner(context.owner, owner)) return;
      const queue = context.tx.objectStore(STORE_QUEUE),
        request = queue.get(order.deviceSeq);
      request.onsuccess = () =>
        runChecked(context.tx, () => {
          const current = request.result as QueuedOrder | undefined;
          if (
            !current ||
            !equalOrder(current, order) ||
            JSON.stringify(current.evidenceEnvelope) !== JSON.stringify(envelope)
          )
            return;
          const rejected = native
            ? [
                ...native.conflicts.map((c) => ({
                  kind: "loose" as const,
                  codeTail: `…${c.rawKm.slice(-6)}`,
                  reason: c.reason,
                })),
                ...(native.boxConflicts ?? []).map((c) => ({
                  kind: "box" as const,
                  sscc: c.sscc,
                  bottleCount: c.bottleCount ?? 1,
                  reason: c.reason,
                })),
              ]
            : [];
          putOutcomeInTransaction(context.tx, {
            owner: {
              serverUrl: owner.binding.serverUrl,
              kioskId: owner.binding.kioskId,
              credentialGeneration: owner.credentialGeneration,
            },
            deviceSeq: order.deviceSeq,
            employeeId: order.employeeId,
            at,
            viewedAt: null,
            kind:
              !native || native.orderNo === "" || native.itemCount === 0
                ? "rejected"
                : rejected.length
                  ? "partial"
                  : "accepted",
            orderNo: native?.orderNo || null,
            acceptedCount: native?.itemCount ?? 0,
            acceptedBoxes: native?.acceptedBoxes ?? [],
            rejected,
          });
          context.tx.objectStore(STORE_JOURNAL).add({
            at,
            createdAt: order.body.createdAt ?? at,
            kioskId: owner.binding.kioskId,
            deviceSeq: order.deviceSeq,
            employeeId: order.employeeId,
            orderNo: native?.orderNo ?? "",
            acceptedCount: native?.itemCount ?? 0,
            conflicts: native?.conflicts ?? [],
            acceptedBoxes: native?.acceptedBoxes ?? [],
            boxConflicts: native?.boxConflicts ?? [],
          });
          if (!native)
            context.tx.objectStore(STORE_QUARANTINE).put({
              ...current,
              grantReceipt: receipt,
              at,
              status: receipt.reconciliation.statusCode ?? 0,
              message: receipt.reason ?? `evidence_${receipt.reconciliation.status}`,
            });
          context.store.put({ owner, envelope, receipt }, evidenceKey(owner, order.deviceSeq));
          queue.delete(order.deviceSeq);
          committed = true;
        });
    },
  );
  return committed;
}
/** Returns false only for legacy orders; evidence errors never select legacy ingestion. */
export async function reconcileEvidenceOrder(
  client: KioskClient,
  order: QueuedOrder,
  now: () => Date,
): Promise<boolean> {
  if (
    !order.grantEvidence?.taskGrantId &&
    !order.evidenceEnvelope &&
    order.evidenceProtocol !== "offline-grants-v1"
  )
    return false;
  const owner = client.registryOwner;
  if (!owner) throw Error("kiosk evidence credential owner unavailable");
  const envelope = await prepare(owner, order);
  if (!envelope) return true;
  if (!client.submitGrantEvidence) throw Error("kiosk evidence transport unavailable");
  const receipt = grantEvidenceReceiptSchema.parse(await client.submitGrantEvidence(envelope));
  if (receipt.batchId !== envelope.batchId) throw Error("kiosk evidence receipt identity mismatch");
  const applied =
    receipt.outcome !== "quarantined" &&
    receipt.reconciliation.status === "applied" &&
    receipt.reconciliation.statusCode !== null &&
    receipt.reconciliation.statusCode >= 200 &&
    receipt.reconciliation.statusCode < 300;
  const parsed = applied ? nativeResultSchema.parse(receipt.reconciliation.result) : null;
  const native: CreateOrderResultDto | null = parsed
    ? {
        orderNo: parsed.orderNo,
        status: parsed.status,
        itemCount: parsed.itemCount,
        conflicts: parsed.conflicts,
        ...(parsed.boxConflicts ? { boxConflicts: parsed.boxConflicts } : {}),
        ...(parsed.acceptedBoxes ? { acceptedBoxes: parsed.acceptedBoxes } : {}),
      }
    : null;
  if (await commit(owner, order, envelope, receipt, native, now().toISOString())) {
    if (native) client.orderReconciled?.(order.body, native);
    client.orderCommitted?.();
    await pruneJournal(now()).catch((error) =>
      console.warn("kiosk: the journal could not be pruned", error),
    );
  }
  return true;
}
