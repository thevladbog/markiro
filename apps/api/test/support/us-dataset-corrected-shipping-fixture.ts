import { randomUUID } from "node:crypto";
import type { Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import type { UsDatasetContext } from "../../src/modules/traceability/demo/us-dataset-contract";
import { readUsDatasetCorrectedShippingInput } from "../../src/modules/traceability/demo/us-dataset-corrected-shipping-prepare";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { datasetCorrectedTransformationStores } from "./us-dataset-corrected-transformation-fixture";
import { UsShippingStore } from "../../src/modules/traceability/shipping/us-shipping-draft";

type Fixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
export function correctedShippingStores(db: Db) {
  return { ...datasetCorrectedTransformationStores(db), shipping: new UsShippingStore(db) };
}

/** Captures only Shipping after real completed prerequisites supplied by the harness. */
export async function captureCorrectedShipping(f: Fixture, context: UsDatasetContext) {
  const stores = correctedShippingStores(f.db);
  const header = await stores.journal.read(context);
  if (!header) throw new Error("Missing actual dataset");
  const input = await readUsDatasetCorrectedShippingInput(stores.journal, context, header.id);
  const stage = await stores.journal.captureIntent(context, header.id, {
    unitKey: "correction_0001",
    stage: "shipping",
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });
  return { stores, header, stage, input };
}

/** Each failpoint is owned by this invocation's randomized disposable child database. */
export async function correctedShippingFault(
  f: Fixture,
  table: string,
  action: "INSERT" | "UPDATE",
  condition: string,
  corrupt = false,
  code = "P0001",
  mutation?: string,
) {
  if (
    ![
      "reference_documents",
      "traceability_events",
      "traceability_lots",
      "shipping_event_items",
      "shipping_event_documents",
      "shipping_event_details",
      "shipping_operations",
      "tenant_audit_events",
      "traceability_demo_dataset_stages",
    ].includes(table)
  )
    throw new Error("Invalid owned Cases fault table");
  const name = "corrected_shipping_fault_" + randomUUID().replaceAll("-", "");
  let functionCreated = false,
    triggerCreated = false;
  async function remove() {
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
    if (errors.length)
      throw new AggregateError(errors, "Owned corrected Shipping failpoint cleanup failed");
  }
  try {
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${mutation ?? (corrupt ? "UPDATE shipping_event_items SET quantity=49;" : `RAISE EXCEPTION 'corrected_shipping_sql_fault' USING ERRCODE='${code}';`)} END IF; RETURN NEW; END $$`,
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

/** Labelled constrained SQL drift; it never operates on the base fixture database. */
export async function corruptCorrectedShipping(
  f: Fixture,
  table: string,
  query: string,
  values: readonly unknown[] = [],
) {
  if (
    ![
      "reference_documents",
      "traceability_events",
      "traceability_lots",
      "shipping_event_items",
      "shipping_event_documents",
      "shipping_event_details",
      "shipping_operations",
      "tenant_audit_events",
      "traceability_demo_dataset_stages",
    ].includes(table)
  )
    throw new Error("Invalid owned Cases drift table");
  const client = await f.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
    const changed = await client.query(query, [...values]);
    if (!changed.rowCount) throw new Error("Missing corrected Shipping drift row");
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
