import { createHash } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq, sql } from "drizzle-orm";
import type {
  PlatformAuditEvent,
  PlatformAuditService,
} from "../../platform-auth/platform-audit.service";
import { digest, receiptBytes } from "./catalog-receipts";
import type { RecoveryPlan } from "./catalog-recovery";
import { CatalogFault } from "./catalog-types";
const {
  releaseCatalogEpochs: epochs,
  releaseCatalogChannels: channels,
  releaseCatalogReceipts: receipts,
  releaseCatalogReservations: reservations,
  releaseCatalogPublications: publications,
  releaseCatalogObjects: objects,
} = schema;
type Actor = Pick<PlatformAuditEvent, "actorPlatformUserId" | "actorRole" | "requestId">;
function reservationId(receiptId: string, entry: unknown) {
  const h = createHash("sha256")
    .update(JSON.stringify([receiptId, entry]))
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** Protected recovery only. The operator must fence every old process before scanning.
 * Failure preserves the fence. This step restores occupancy, never visibility or writer access.
 */
export async function reconcileRecovery(
  db: Db,
  plan: RecoveryPlan,
  audit: Pick<PlatformAuditService, "record">,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    await tx.execute(sql`LOCK TABLE release_catalog_epochs IN SHARE ROW EXCLUSIVE MODE`);
    await tx.update(epochs).set({ enabled: false });
    await tx.update(channels).set({ readable: false });
    await audit.record(tx, {
      ...actor,
      action: "release_catalog.recovery.fence",
      outcome: "success",
      tenantId: null,
      targetType: "release_catalog",
      targetId: null,
      reason: null,
      before: null,
      after: { writersEnabled: false, channelsReadable: false },
    });
  });
  if (plan.writersMayEnable !== false) throw new CatalogFault("not_ready");
  const proofs = new Map(plan.receipts.map((r) => [r.operation.id, r]));
  if (proofs.size !== plan.receipts.length) throw new CatalogFault("not_ready");
  for (const r of proofs.values())
    if (
      r.proof.operationId !== r.operation.id ||
      digest(receiptBytes(r.operation)) !== r.proof.sha256
    )
      throw new CatalogFault("not_ready");
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '15s'`);
    await tx.execute(sql`LOCK TABLE release_catalog_epochs IN SHARE ROW EXCLUSIVE MODE`);
    if ((await tx.select().from(epochs).where(eq(epochs.enabled, true))).length)
      throw new CatalogFault("not_ready");
    // Restored evidence must be a subset of the independently complete journal.
    for (const row of await tx.select().from(receipts)) {
      const r = proofs.get(row.id);
      if (
        !r ||
        r.operation.kind !== row.kind ||
        r.proof.sha256 !== row.sha256 ||
        r.proof.ledgerKey !== row.ledgerKey
      )
        throw new CatalogFault("not_ready");
    }
    for (const row of await tx.select().from(publications)) {
      const found = plan.reservedPublications.find(
        (r) =>
          r.operation.identity.product === row.product &&
          r.operation.identity.channel === row.channel &&
          r.operation.identity.version === row.version,
      );
      if (
        !found ||
        found.operation.requestDigest !== row.requestDigest ||
        found.operation.sourceSha !== row.sourceSha
      )
        throw new CatalogFault("not_ready");
      const files = await tx.select().from(objects).where(eq(objects.publicationId, row.id));
      if (
        files.length !== found.operation.files.length ||
        files.some(
          (f) =>
            !found.operation.files.some(
              (p) =>
                p.publicPath === f.publicPath &&
                p.bucket === f.bucket &&
                p.key === f.key &&
                p.versionId === f.versionId &&
                p.sha256 === f.sha256 &&
                p.sizeBytes === f.sizeBytes &&
                p.contentType === f.contentType,
            ),
        )
      )
        throw new CatalogFault("not_ready");
    }
    for (const r of proofs.values())
      await tx
        .insert(receipts)
        .values({
          id: r.operation.id,
          kind: r.operation.kind,
          sha256: r.proof.sha256,
          ledgerKey: r.proof.ledgerKey,
          ledgerVersionId: r.proof.ledgerVersionId,
        })
        .onConflictDoNothing();
    const rows: (typeof reservations.$inferInsert)[] = [];
    for (const { operation: op } of plan.reservedPublications) {
      const scope = { product: op.identity.product, channel: op.identity.channel };
      const entries = [
        { kind: "version", version: op.identity.version },
        ...op.files.map((f) => ({
          kind: "path",
          version: op.identity.version,
          publicPath: f.publicPath,
        })),
      ];
      for (const entry of entries)
        rows.push({
          id: reservationId(op.id, entry),
          ...scope,
          ...entry,
          requestDigest: op.requestDigest,
          receiptId: op.id,
        });
    }
    for (const { operation: op } of plan.reservations)
      for (const entry of op.entries)
        rows.push({ id: reservationId(op.id, entry), ...op.identity, ...entry, receiptId: op.id });
    for (const row of rows) await tx.insert(reservations).values(row).onConflictDoNothing();
    await audit.record(tx, {
      ...actor,
      action: "release_catalog.recovery.reserve",
      outcome: "success",
      tenantId: null,
      targetType: "release_catalog",
      targetId: null,
      reason: null,
      before: null,
      after: {
        receiptCount: proofs.size,
        reservationCount: rows.length,
        writersEnabled: false,
        channelsReadable: false,
      },
    });
  });
}
