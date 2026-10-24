import { releaseOperationIdSchema, releaseSha256Schema } from "@markiro/platform-contracts";
import {
  checkLimits,
  scanDeadline,
  digest,
  enumerateVersions,
  MAX_RECEIPT_BYTES,
  parseReceipt,
  pinnedBytes,
  receiptBytes,
  type ChannelOperation,
  type PublicationOperation,
  type ReceiptOperation,
  type ReservationOperation,
  type ScanLimits,
} from "./catalog-receipts";
import type { CatalogStore } from "./catalog-store";
import { CatalogFault, type VerifiedReceipt } from "./catalog-types";
interface RecoveryInput extends ScanLimits {
  bucket: string;
  writersFenced: boolean;
  independentInventoryComplete: boolean;
  independentInventory: { id: string; sha256: string }[];
  technicalKeys: string[];
}
interface Recovered<T> {
  operation: T;
  proof: VerifiedReceipt;
}
export interface RecoveryChannel {
  identity: ChannelOperation["identity"];
  revision: string;
  publicationId: string | null;
  readable: boolean;
  reason: string | null;
  pointer: ChannelOperation["pointer"] | null;
}
export interface RecoveryPlan {
  writersMayEnable: false;
  reservedPublications: Recovered<PublicationOperation>[];
  reservations: Recovered<ReservationOperation>[];
  publications: (Recovered<PublicationOperation> & { publicationId: string })[];
  channels: RecoveryChannel[];
  receipts: Recovered<ReceiptOperation>[];
}
/** A read-only reconstruction plan. It never enables writers or installs inferred pointers. */
export async function scanRecovery(
  store: CatalogStore,
  input: RecoveryInput,
): Promise<RecoveryPlan> {
  checkLimits(input);
  const remaining = scanDeadline(input.timeoutMs);
  if (!input.writersFenced || !input.independentInventoryComplete)
    throw new CatalogFault("not_ready");
  const independent = new Map<string, string>();
  for (const record of input.independentInventory) {
    if (
      !releaseOperationIdSchema.safeParse(record.id).success ||
      !releaseSha256Schema.safeParse(record.sha256).success ||
      independent.has(record.id)
    )
      throw new CatalogFault("not_ready");
    independent.set(record.id, record.sha256);
  }
  if (independent.size > input.maxRecords) throw new CatalogFault("not_ready");
  const technical = new Set(input.technicalKeys);
  for (const key of technical) {
    const match = /^_publication-ledger\/_storage-readiness\/([a-f0-9-]{36})\.txt$/.exec(key);
    if (!match || !releaseOperationIdSchema.safeParse(match[1]).success)
      throw new CatalogFault("not_ready");
  }
  const records = new Map<string, Recovered<ReceiptOperation>>();
  let total = 0;
  for (const v of await enumerateVersions(store, { ...input, timeoutMs: remaining() })) {
    if (technical.has(v.key)) continue;
    const match = /^_publication-ledger\/([a-f0-9-]{36})\.json$/.exec(v.key);
    if (!match || !releaseOperationIdSchema.safeParse(match[1]).success || v.deleted)
      throw new CatalogFault("not_ready");
    const bytes = await pinnedBytes(
      store,
      input.bucket,
      v,
      Math.min(MAX_RECEIPT_BYTES, input.maxBytes - total),
      remaining(),
    );
    total += bytes.length;
    if (total > input.maxBytes) throw new CatalogFault("not_ready");
    const op = parseReceipt(bytes),
      sha = digest(bytes);
    if (op.id !== match[1] || independent.get(op.id) !== sha) throw new CatalogFault("not_ready");
    const prior = records.get(op.id);
    if (prior) {
      if (prior.proof.sha256 !== sha) throw new CatalogFault("not_ready");
      continue;
    }
    records.set(op.id, {
      operation: op,
      proof: { operationId: op.id, sha256: sha, ledgerKey: v.key, ledgerVersionId: v.versionId },
    });
  }
  if (records.size !== independent.size) throw new CatalogFault("not_ready");
  const confirmations = new Map<
    string,
    Extract<ReceiptOperation, { kind: "confirmation" }>["result"]
  >();
  for (const { operation: op } of records.values())
    if (op.kind === "confirmation") {
      const target = records.get(op.preparedId);
      if (
        !target ||
        target.proof.sha256 !== op.preparedSha256 ||
        target.operation.kind !== op.result.kind
      )
        throw new CatalogFault("not_ready");
      if (
        target.operation.kind === "channel" &&
        (op.result.kind !== "channel" ||
          op.result.publicationId !== target.operation.publicationId ||
          op.result.revision !== target.operation.revision)
      )
        throw new CatalogFault("not_ready");
      const prior = confirmations.get(op.preparedId);
      if (prior && JSON.stringify(prior) !== JSON.stringify(op.result))
        throw new CatalogFault("not_ready");
      confirmations.set(op.preparedId, op.result);
    }
  const reservedPublications: RecoveryPlan["reservedPublications"] = [],
    reservations: RecoveryPlan["reservations"] = [],
    publications: RecoveryPlan["publications"] = [],
    channelOps = new Map<string, ChannelOperation[]>(),
    paths = new Map<string, string>(),
    identities = new Map<string, string>(),
    publishedIds = new Map<string, PublicationOperation>();
  for (const r of records.values()) {
    const op = r.operation;
    if (op.kind === "publication") {
      if (op.files.some((f) => f.bucket !== input.bucket)) throw new CatalogFault("not_ready");
      const identity = JSON.stringify(op.identity),
        binding = digest(
          receiptBytes({
            ...op,
            id: "00000000-0000-4000-8000-000000000000",
            epoch: "00000000-0000-4000-8000-000000000000",
          }),
        ),
        prior = identities.get(identity);
      if (prior && prior !== binding) throw new CatalogFault("not_ready");
      identities.set(identity, binding);
      for (const file of op.files) {
        const binding = JSON.stringify(file),
          old = paths.get(file.publicPath);
        if (old && old !== binding) throw new CatalogFault("not_ready");
        paths.set(file.publicPath, binding);
      }
      reservedPublications.push({ operation: op, proof: r.proof });
      const confirmation = confirmations.get(op.id);
      if (confirmation?.kind === "publication") {
        const old = publishedIds.get(confirmation.publicationId);
        if (old && !receiptBytes(old).equals(receiptBytes(op))) throw new CatalogFault("not_ready");
        publishedIds.set(confirmation.publicationId, op);
        publications.push({
          operation: op,
          proof: r.proof,
          publicationId: confirmation.publicationId,
        });
      }
    } else if (op.kind === "reservation") reservations.push({ operation: op, proof: r.proof });
    else if (op.kind === "channel") {
      const key = `${op.identity.product}/${op.identity.channel}`,
        list = channelOps.get(key) ?? [];
      list.push(op);
      channelOps.set(key, list);
    }
  }
  const channels: RecoveryChannel[] = [];
  for (const list of channelOps.values()) {
    const first = list[0];
    if (!first) continue;
    let revision = 0n,
      publicationId: string | null = null,
      pointer: ChannelOperation["pointer"] | null = null,
      reason: string | null = null;
    list.sort((a, b) =>
      BigInt(a.revision) < BigInt(b.revision)
        ? -1
        : BigInt(a.revision) > BigInt(b.revision)
          ? 1
          : 0,
    );
    for (const op of list) {
      const target = publishedIds.get(op.publicationId);
      if (!confirmations.has(op.id)) {
        reason = "unconfirmed_channel";
        break;
      }
      if (
        !target ||
        target.identity.product !== op.identity.product ||
        target.identity.channel !== op.identity.channel ||
        BigInt(op.expectedRevision) !== revision ||
        op.previousPublicationId !== publicationId
      ) {
        reason = "inconsistent_channel_chain";
        break;
      }
      revision = BigInt(op.revision);
      publicationId = op.publicationId;
      pointer = op.pointer;
    }
    channels.push({
      identity: first.identity,
      revision: revision.toString(),
      publicationId,
      readable: reason === null,
      reason,
      pointer: reason === null ? pointer : null,
    });
  }
  return {
    writersMayEnable: false,
    reservedPublications,
    reservations,
    publications,
    channels,
    receipts: [...records.values()],
  };
}
