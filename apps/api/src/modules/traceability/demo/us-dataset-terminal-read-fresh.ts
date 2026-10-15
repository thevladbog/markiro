import { schema } from "@markiro/db";
import { and, eq } from "drizzle-orm";
import { freshUsLotReaders } from "../lots/us-lot-read.js";
import { authorizeUsMasterData } from "../master-data/us-master-data-support.js";
import { readShippingRevisions } from "../shipping/us-shipping-history.js";
import { lockUsDatasetShipping } from "./us-dataset-shipping-locks.js";
import { lockUsDatasetTransformation } from "./us-dataset-transformation-locks.js";
import {
  lockUsDatasetReferenceParents,
  lockUsDatasetReceivingDocuments,
  lockUsDatasetShippingDocuments,
  lockUsDatasetShippingReferences,
  lockUsDatasetTransformationDocuments,
  readUsDatasetReceivingRootForUpdate,
  readUsDatasetReceivingRevisionForUpdate,
  readUsDatasetTransformationRevision,
} from "./us-dataset-terminal-lock-operations.js";
import type {
  UsDatasetTerminalDependencies,
  UsDatasetTerminalLockOperations,
  UsDatasetTerminalPointRows,
} from "./us-dataset-terminal-read-contract.js";

const freshPoints: UsDatasetTerminalPointRows = {
  lot: freshUsLotReaders.lot,
  async document(tx, tenantId, id) {
    const table = schema.referenceDocuments;
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    return row;
  },
  async event(tx, tenantId, id) {
    const table = schema.traceabilityEvents;
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    return row;
  },
  async receivingRoot(tx, tenantId, id) {
    const table = schema.receivingEventRoots;
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    return row;
  },
  async transformationRoot(tx, tenantId, id) {
    const table = schema.transformationEventRoots;
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    return row;
  },
  async shippingRoot(tx, tenantId, id) {
    const table = schema.shippingEventRoots;
    const [row] = await tx
      .select()
      .from(table)
      .where(and(eq(table.tenantId, tenantId), eq(table.id, id)));
    return row;
  },
};

const freshLocks: UsDatasetTerminalLockOperations = {
  receivingRoot: readUsDatasetReceivingRootForUpdate,
  receivingRevision: readUsDatasetReceivingRevisionForUpdate,
  transformationRevision: readUsDatasetTransformationRevision,
  referenceParents: lockUsDatasetReferenceParents,
  receivingDocuments: lockUsDatasetReceivingDocuments,
  transformationDocuments: lockUsDatasetTransformationDocuments,
  shippingReferences: lockUsDatasetShippingReferences,
  shippingDocuments: lockUsDatasetShippingDocuments,
  transformation: lockUsDatasetTransformation,
  shipping: lockUsDatasetShipping,
};

/** Stateless native bindings; ordinary facades never keep transaction or row state. */
export function freshUsDatasetTerminalDependencies<T extends object>(
  stores: T,
): T & Pick<UsDatasetTerminalDependencies, "authorize" | "points" | "locks" | "shippingRevisions"> {
  return {
    ...stores,
    authorize: authorizeUsMasterData,
    points: freshPoints,
    locks: freshLocks,
    shippingRevisions: readShippingRevisions,
  };
}
