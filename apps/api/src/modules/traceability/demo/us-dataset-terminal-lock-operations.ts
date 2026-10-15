import { schema } from "@markiro/db";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import type { UsDatasetReferenceResult } from "./us-dataset-reference-contract.js";
import { datasetReferenceError } from "./us-dataset-reference-contract.js";
import { datasetShippingError } from "./us-dataset-shipping-contract.js";
import type { RawDocument } from "./us-dataset-terminal-read-contract.js";

/** Full locked root observation; the verifier keeps its original field comparisons. */
export async function readUsDatasetReceivingRootForUpdate(
  tx: UsDemoTransaction,
  tenantId: string,
  rootId: string,
) {
  const roots = schema.receivingEventRoots;
  const [root] = await tx
    .select()
    .from(roots)
    .where(and(eq(roots.tenantId, tenantId), eq(roots.id, rootId)))
    .for("update");
  return root;
}

/** Always executes the original locked range and validates its unique typed identity. */
export async function readUsDatasetReceivingRevisionForUpdate(
  tx: UsDemoTransaction,
  tenantId: string,
  rootId: string,
) {
  const events = schema.traceabilityEvents;
  const revisions = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.rootEventId, rootId)))
    .orderBy(asc(events.id))
    .for("update");
  if (revisions.length !== 1) return undefined;
  const event = revisions[0];
  if (
    !event ||
    event.id !== rootId ||
    event.type !== "receiving" ||
    event.status !== "finalized" ||
    event.revision !== 1 ||
    event.previousRevisionId !== null ||
    event.supersededByEventId !== null
  )
    return undefined;
  return event;
}

/** This range adds no lock: eligibility still requires the earlier native lock plan. */
export async function readUsDatasetTransformationRevision(
  tx: UsDemoTransaction,
  tenantId: string,
  rootId: string,
) {
  const events = schema.traceabilityEvents;
  const revisions = await tx
    .select()
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.rootEventId, rootId)))
    .orderBy(asc(events.id));
  if (revisions.length !== 1) return undefined;
  const event = revisions[0];
  if (
    !event ||
    event.id !== rootId ||
    event.type !== "transformation" ||
    event.status !== "finalized" ||
    event.revision !== 1
  )
    return undefined;
  return event;
}

type Bindings = UsDatasetReferenceResult["bindings"];
type IdRow = Readonly<{ id: string }>;

/** The reference verifier's original parent-share order and cardinality gates. */
export async function lockUsDatasetReferenceParents(
  tx: UsDemoTransaction,
  tenantId: string,
  bindings: Bindings,
): Promise<
  Readonly<{ parties: readonly IdRow[]; locations: readonly IdRow[]; products: readonly IdRow[] }>
> {
  const selected: IdRow[][] = [];
  for (const [table, rows] of [
    [schema.traceabilityParties, bindings.parties],
    [schema.traceabilityLocations, bindings.locations],
    [schema.products, bindings.products],
  ] as const) {
    const owned = await tx
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.tenantId, tenantId), inArray(table.id, rows.map(({ id }) => id).sort())))
      .orderBy(asc(table.id))
      .for("share");
    if (owned.length !== rows.length) throw datasetReferenceError("us_dataset_reference_mismatch");
    selected.push(owned);
  }
  return { parties: selected[0] ?? [], locations: selected[1] ?? [], products: selected[2] ?? [] };
}

/** Exact document-ID share used by Receiving; caller retains its existing length comparison. */
export async function lockUsDatasetReceivingDocuments(
  tx: UsDemoTransaction,
  tenantId: string,
  ids: readonly string[],
): Promise<IdRow[]> {
  const documents = schema.referenceDocuments;
  return tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, [...ids])))
    .orderBy(asc(documents.id))
    .for("share");
}

/** Exact document-ID share used by Transformation; kept a separate fixed operation. */
export async function lockUsDatasetTransformationDocuments(
  tx: UsDemoTransaction,
  tenantId: string,
  ids: readonly string[],
): Promise<IdRow[]> {
  const docs = schema.referenceDocuments;
  return tx
    .select({ id: docs.id })
    .from(docs)
    .where(and(eq(docs.tenantId, tenantId), inArray(docs.id, [...ids])))
    .orderBy(asc(docs.id))
    .for("share");
}

/** Shipping's three reference shares followed by its distinct profile share. */
export async function lockUsDatasetShippingReferences(
  tx: UsDemoTransaction,
  tenantId: string,
  unitKey: string,
  bindings: Bindings,
): Promise<
  Readonly<{
    parties: readonly IdRow[];
    locations: readonly IdRow[];
    products: readonly IdRow[];
    profiles: readonly IdRow[];
  }>
> {
  const fail = () => datasetShippingError("us_dataset_shipping_conflict", unitKey);
  const selected: IdRow[][] = [];
  for (const [table, owned] of [
    [schema.traceabilityParties, bindings.parties],
    [schema.traceabilityLocations, bindings.locations],
    [schema.products, bindings.products],
  ] as const) {
    const shares = await tx
      .select({ id: table.id })
      .from(table)
      .where(
        and(
          eq(table.tenantId, tenantId),
          inArray(
            table.id,
            owned.map((row) => row.id),
          ),
        ),
      )
      .orderBy(asc(table.id))
      .for("share");
    if (shares.length !== owned.length) throw fail();
    selected.push(shares);
  }
  const profiles = schema.productTraceabilityProfiles;
  const profileShares = await tx
    .select({ id: profiles.productId })
    .from(profiles)
    .where(
      and(
        eq(profiles.tenantId, tenantId),
        inArray(
          profiles.productId,
          bindings.products.map((row) => row.id),
        ),
      ),
    )
    .orderBy(asc(profiles.productId))
    .for("share");
  if (profileShares.length !== bindings.products.length) throw fail();
  return {
    parties: selected[0] ?? [],
    locations: selected[1] ?? [],
    products: selected[2] ?? [],
    profiles: profileShares,
  };
}

export type UsDatasetShippingDocumentDefinition = Readonly<{
  type: RawDocument["type"];
  number: string;
  partyId: string;
}>;
export type UsDatasetShippingDocumentShare = Readonly<{
  id: string;
  type: RawDocument["type"];
  number: string;
  partyId: RawDocument["partyId"];
}>;

/** Returns only actual partial rows; absence is compared after Cases proof by the caller. */
export async function lockUsDatasetShippingDocuments(
  tx: UsDemoTransaction,
  tenantId: string,
  ownedIds: readonly string[],
  definitions: readonly UsDatasetShippingDocumentDefinition[],
): Promise<UsDatasetShippingDocumentShare[]> {
  const docs = schema.referenceDocuments;
  return tx
    .select({ id: docs.id, type: docs.type, number: docs.number, partyId: docs.partyId })
    .from(docs)
    .where(
      and(
        eq(docs.tenantId, tenantId),
        or(
          inArray(docs.id, [...ownedIds]),
          ...definitions.map((row) =>
            and(
              eq(docs.type, row.type),
              eq(docs.number, row.number),
              eq(docs.partyId, row.partyId),
            ),
          ),
        ),
      ),
    )
    .orderBy(asc(docs.id))
    .for("share");
}
