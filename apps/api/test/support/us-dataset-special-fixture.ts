import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import {
  createTransformationDraftSchema,
  finalizeTransformationSchema,
} from "@markiro/platform-contracts";
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest";
import { UsDatasetJournalStore } from "../../src/modules/traceability/demo/us-dataset-journal";
import { UsDatasetReferenceSeedStore } from "../../src/modules/traceability/demo/us-dataset-reference-seed";
import { UsDatasetRegularSeedStore } from "../../src/modules/traceability/demo/us-dataset-regular-seed";
import { makeUsDatasetReferenceIdentity } from "../../src/modules/traceability/demo/us-dataset-receiving-contract";
import {
  makeUsDatasetSpecialInput,
  makeUsDatasetSpecialStageIdentity,
  type UsDatasetSpecialKind,
} from "../../src/modules/traceability/demo/us-dataset-special-contract";
import { UsDatasetSpecialSeedStore } from "../../src/modules/traceability/demo/us-dataset-special-seed";
import { usSixMonthDefinition } from "../../src/modules/traceability/demo/us-six-month-definition";
import type { UsDatasetContext } from "../../src/modules/traceability/demo/us-dataset-contract";
import { UsCatalogStore } from "../../src/modules/traceability/catalog/us-catalog-store";
import { UsReferenceDocumentStore } from "../../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../../src/modules/traceability/master-data/us-master-data-store";
import { UsProductProfileStore } from "../../src/modules/traceability/products/us-product-profile-store";
import { UsReceivingStore } from "../../src/modules/traceability/receiving/us-receiving-store";
import { UsTransformationStore } from "../../src/modules/traceability/transformation/us-transformation-store";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-store";
import type { UsDatasetSpecialLifecycleResult } from "../../src/modules/traceability/demo/us-dataset-special-contract";
import { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";

type Fixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
type SpecialFixtureHarness = Readonly<{
  f: Fixture;
  context: Awaited<ReturnType<Fixture["provision"]>>;
  phase<Args extends unknown[]>(
    run: (...args: Args) => Promise<void>,
  ): (...args: Args) => Promise<void>;
}>;
/** Full phases, not only individual queries, own the disposable dataset fixture. */
export function specialFixture(base: string | undefined): SpecialFixtureHarness {
  let fixture: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof fixture.provision>>;
  let acquisition: Promise<void> | undefined;
  const work = new Set<Promise<unknown>>();
  function track<T>(pending: Promise<T>): Promise<T> {
    work.add(pending);
    void pending.then(
      () => work.delete(pending),
      () => work.delete(pending),
    );
    return pending;
  }
  const phase =
    <Args extends unknown[]>(run: (...args: Args) => Promise<void>) =>
    (...args: Args) =>
      track(Promise.resolve().then(() => run(...args)));
  async function drain() {
    while (work.size) await Promise.allSettled([...work]);
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    acquisition = Promise.resolve()
      .then(() => createUsDatasetJournalFixture(base))
      .then((value) => {
        fixture = value;
        console.info(`Owned special dataset database: ${fixture.databaseName}`);
      });
    // Independent acquisition survives a timed-out hook; the phase is registered
    // before its first setup continuation can start.
    await track(acquisition);
  }, 60_000);
  beforeEach(() => {
    if (work.size) throw new Error("special_dataset_prior_work_live");
    return phase(async () => {
      context = await fixture.provision();
    })();
  }, 60_000);
  afterEach(drain, 60_000);
  afterAll(async () => {
    await acquisition?.catch(() => undefined);
    await drain();
    if (!fixture) return;
    try {
      const active = await fixture.pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend' AND state<>'idle'",
      );
      expect(active.rows).toEqual([{ n: 0 }]);
      console.info(`Special dataset work drained: ${fixture.databaseName}`);
    } finally {
      await fixture.close();
    }
  }, 60_000);
  return {
    get f() {
      return fixture;
    },
    get context() {
      return context;
    },
    phase,
  };
}

export function specialStores(db: Db) {
  return {
    journal: new UsDatasetJournalStore(db, usSixMonthDefinition),
    master: new UsMasterDataStore(db),
    catalog: new UsCatalogStore(db),
    profiles: new UsProductProfileStore(db),
    documents: new UsReferenceDocumentStore(db),
    lots: new UsLotStore(db),
    receiving: new UsReceivingStore(db),
  };
}
export async function captureSpecial(
  db: Db,
  context: UsDatasetContext,
  kind: UsDatasetSpecialKind,
  lifecycle = false,
) {
  const stores = specialStores(db);
  const refs = await new UsDatasetReferenceSeedStore(db).initialize(context);
  const header = await stores.journal.read(context);
  if (!header) throw new Error("Missing fixture header");
  const references = await stores.journal.readStage(context, header.id, "references", "references");
  if (!references?.receipt) throw new Error("Missing fixture references");
  const unit = kind === "correction" ? "correction_0001" : "orphan_0001";
  if (lifecycle) await new UsDatasetSpecialSeedStore(db).initializeReceiving(context, kind);
  const original = lifecycle
    ? await stores.journal.readStage(context, header.id, unit, "receiving")
    : null;
  const name = lifecycle
    ? kind === "correction"
      ? "amend_receiving"
      : "void_receiving"
    : "receiving";
  const input = makeUsDatasetSpecialInput(
    kind,
    name,
    makeUsDatasetReferenceIdentity(header.id, references),
    original ? makeUsDatasetSpecialStageIdentity(header.id, original) : null,
  );
  const stage = await stores.journal.captureIntent(context, header.id, {
    unitKey: unit,
    stage: name,
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });
  return { stores, header, refs, original, input, stage };
}

/** Only owned randomized trigger/function names in this fixture; both removals run independently. */
export async function specialFault(
  f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  table: string,
  action: string,
  condition: string,
  code = "P0001",
  corrupt = false,
) {
  if (
    ![
      "traceability_events",
      "tenant_audit_events",
      "receiving_operations",
      "traceability_demo_dataset_stages",
    ].includes(table)
  )
    throw new Error("Invalid owned fault table");
  if (action !== "INSERT" && action !== "UPDATE") throw new Error("Invalid owned fault operation");
  const name = "special_fault_" + randomUUID().replaceAll("-", "");
  let functionCreated = false,
    triggerCreated = false;
  const remove = async () => {
    const errors: unknown[] = [];
    if (triggerCreated)
      try {
        await f.pool.query(`DROP TRIGGER ${name} ON ${table}`);
        triggerCreated = false;
      } catch (error) {
        errors.push(error);
      }
    if (functionCreated)
      try {
        await f.pool.query(`DROP FUNCTION ${name}()`);
        functionCreated = false;
      } catch (error) {
        errors.push(error);
      }
    if (errors.length) throw new AggregateError(errors, "Owned special fault removal failed");
  };
  try {
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${corrupt ? "UPDATE reference_documents SET notes='Synthetic trigger drift';" : `RAISE EXCEPTION 'special_sql_fault' USING ERRCODE='${code}';`} END IF; RETURN NEW; END $$`,
    );
    functionCreated = true;
    await f.pool.query(
      `CREATE TRIGGER ${name} ${corrupt ? "AFTER" : "BEFORE"} ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
    );
    triggerCreated = true;
    return remove;
  } catch (error) {
    await remove();
    throw error;
  }
}

/** Real downstream composition remains test-local and its failing draft rolls back. */
export async function consumeSpecial(
  db: Db,
  context: UsDatasetContext,
  result: UsDatasetSpecialLifecycleResult,
) {
  const refs = await new UsDatasetReferenceSeedStore(db).verify(context);
  const stores = specialStores(db);
  const transformation = new UsTransformationStore(db);
  const bound = (entries: readonly { key: string; id: string }[], key: string) => {
    const id = entries.find((e) => e.key === key)?.id;
    if (!id) throw new Error("Missing test binding");
    return id;
  };
  return db.transaction(async (tx) => {
    const key = randomUUID();
    const documents = [];
    for (const type of ["work_order", "batch_log"] as const)
      documents.push(
        await stores.documents.createDocumentInTransaction(
          tx,
          context.tenantId,
          context.actorUserId,
          {
            type,
            typeOtherLabel: null,
            number: "Synthetic consumption " + key + type,
            issuedOn: "2026-08-11",
            partyId: bound(refs.bindings.parties, "processor"),
            notes: null,
          },
          key,
        ),
      );
    const created = await transformation.createDraftInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      createTransformationDraftSchema.parse({
        operationKey: key,
        draft: {
          eventDate: "2026-08-11",
          processorLocationId: bound(refs.bindings.locations, "processor"),
          reason: "commingling_and_repacking",
          reasonNote: null,
          notes: "Test-only real consumption",
          documentIds: documents.map((d) => d.id),
          inputs: result.lots.map((lot) => ({
            kind: "ftl_lot",
            lotId: lot.id,
            quantity: "10",
            unitOfMeasure: "lb",
          })),
          outputs: [
            {
              productId: bound(refs.bindings.products, "output_02"),
              tlc: "Synthetic-" + key,
              quantity: "1",
              unitOfMeasure: "case",
            },
          ],
        },
      }),
      key,
    );
    const ready = await transformation.checkReadinessInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      { expectedDraftVersion: created.draftVersion },
    );
    // Call the real finalizer even when incomplete, proving rejection at its native boundary.
    return transformation.finalizeInTransaction(
      tx,
      context.tenantId,
      context.actorUserId,
      created.id,
      finalizeTransformationSchema.parse({
        operationKey: key,
        expectedDraftVersion: created.draftVersion,
        expectedInputDigest: ready.inputDigest,
      }),
      key,
    );
  });
}

/** Negative drift only, matching the regular verifier fixture's immutable-history probe. */
export async function corruptSpecial(
  f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>,
  table: "traceability_events" | "receiving_event_items" | "receiving_event_roots",
  query: string,
  values: string[],
) {
  const client = await f.pool.connect();
  const guards =
    table === "traceability_events"
      ? ["receiving_event_identity_guard", "receiving_event_root_consistency_guard"]
      : table === "receiving_event_items"
        ? ["receiving_items_draft_guard"]
        : ["receiving_root_identity_guard", "receiving_root_consistency_guard"];
  try {
    await client.query("BEGIN");
    for (const guard of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
    await client.query(query, values);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const guard of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${guard}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export type OrphanSupportKind =
  | "transformation input"
  | "transformation draft input"
  | "transformation output"
  | "shipping item"
  | "shipping draft item"
  | "active case"
  | "historical case"
  | "genealogy input"
  | "genealogy output";
/** Actual unrelated native chain first; only its support FK is then deliberately corrupted. */
export async function corruptOrphanSupport(
  f: Fixture,
  context: UsDatasetContext,
  lotId: string,
  kind: OrphanSupportKind,
) {
  await new UsDatasetRegularSeedStore(f.db).initialize(context, { startIndex: 0, count: 1 });
  let draftId: string | undefined;
  if (kind === "transformation draft input" || kind === "shipping draft item") {
    const unrelated = (
      await f.pool.query<{ lot_id: string }>(
        "SELECT lot_id FROM transformation_event_inputs WHERE tenant_id=$1 ORDER BY event_id,line_no LIMIT 1",
        [context.tenantId],
      )
    ).rows[0]?.lot_id;
    if (!unrelated) throw new Error("Missing actual unrelated lot");
    const key = randomUUID();
    const draft =
      kind === "transformation draft input"
        ? await new UsTransformationStore(f.db).createDraft(
            context.tenantId,
            context.actorUserId,
            {
              operationKey: key,
              draft: {
                eventDate: null,
                processorLocationId: null,
                reason: null,
                reasonNote: null,
                notes: null,
                documentIds: [],
                inputs: [
                  { kind: "ftl_lot", lotId: unrelated, quantity: null, unitOfMeasure: null },
                ],
                outputs: [],
              },
            },
            key,
          )
        : await new UsShippingStore(f.db).createDraft(
            context.tenantId,
            context.actorUserId,
            {
              operationKey: key,
              draft: {
                eventDate: null,
                shipFromLocationId: null,
                recipientLocationId: null,
                carrierReference: null,
                notes: null,
                documentIds: [],
                items: [{ lotId: unrelated, quantity: null, unitOfMeasure: null }],
              },
            },
            key,
          );
    draftId = draft.id;
  }
  const table =
    kind === "transformation input" || kind === "transformation draft input"
      ? "transformation_event_inputs"
      : kind === "transformation output"
        ? "transformation_event_outputs"
        : kind === "shipping item" || kind === "shipping draft item"
          ? "shipping_event_items"
          : kind === "active case" || kind === "historical case"
            ? "trace_lot_boxes"
            : "lot_genealogy_edges";
  const guard =
    table === "transformation_event_inputs"
      ? "transformation_inputs_write_guard"
      : table === "transformation_event_outputs"
        ? "transformation_outputs_write_guard"
        : table === "shipping_event_items"
          ? "shipping_items_write_guard"
          : table === "trace_lot_boxes"
            ? "trace_lot_boxes_guard_trigger"
            : "lot_genealogy_write_guard";
  const connection = await f.pool.connect();
  try {
    await connection.query("BEGIN");
    const row = (
      await connection.query<{
        id?: string;
        event_id?: string;
        line_no?: number;
        input_lot_id?: string;
        output_lot_id?: string;
      }>(
        `SELECT * FROM ${table} WHERE tenant_id=$1${draftId ? " AND event_id=$2" : ""} ORDER BY ${table === "trace_lot_boxes" ? "id" : "event_id"} LIMIT 1 FOR UPDATE`,
        draftId ? [context.tenantId, draftId] : [context.tenantId],
      )
    ).rows[0];
    if (!row) throw new Error("Missing actual native support row");
    await connection.query(`ALTER TABLE ${table} DISABLE TRIGGER ${guard}`);
    let affected: number | null;
    if (table === "trace_lot_boxes") {
      affected = (
        await connection.query(
          `UPDATE ${table} SET lot_id=$1${kind === "historical case" ? ",unlinked_at=now(),unlinked_by=$4,unlink_reason='Negative historical support'" : ""} WHERE tenant_id=$2 AND id=$3`,
          kind === "historical case"
            ? [lotId, context.tenantId, row.id, context.actorUserId]
            : [lotId, context.tenantId, row.id],
        )
      ).rowCount;
    } else if (table === "lot_genealogy_edges") {
      const column = kind === "genealogy input" ? "input_lot_id" : "output_lot_id";
      affected = (
        await connection.query(
          `UPDATE ${table} SET ${column}=$1 WHERE tenant_id=$2 AND event_id=$3 AND input_lot_id=$4 AND output_lot_id=$5`,
          [lotId, context.tenantId, row.event_id, row.input_lot_id, row.output_lot_id],
        )
      ).rowCount;
    } else {
      affected = (
        await connection.query(
          `UPDATE ${table} SET lot_id=$1 WHERE tenant_id=$2 AND event_id=$3 AND line_no=$4`,
          [lotId, context.tenantId, row.event_id, row.line_no],
        )
      ).rowCount;
    }
    if (affected !== 1) throw new Error("Missing exact support drift mutation");
    await connection.query("SET CONSTRAINTS ALL IMMEDIATE");
    await connection.query(`ALTER TABLE ${table} ENABLE TRIGGER ${guard}`);
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  } finally {
    connection.release();
  }
}
