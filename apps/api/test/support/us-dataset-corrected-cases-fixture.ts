import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import type {
  UsDatasetContext,
  UsDatasetIntent,
} from "../../src/modules/traceability/demo/us-dataset-contract";
import { makeUsDatasetCorrectedCasesInput } from "../../src/modules/traceability/demo/us-dataset-corrected-cases-contract";
import { UsDatasetCorrectedTransformationSeedStore } from "../../src/modules/traceability/demo/us-dataset-corrected-transformation-seed";
import { makeUsDatasetReferenceIdentity } from "../../src/modules/traceability/demo/us-dataset-receiving-contract";
import { makeUsSixMonthSpecialExamples } from "../../src/modules/traceability/demo/us-six-month-definition";
import type { createUsDatasetJournalFixture } from "./us-dataset-journal-fixture";
import { prepareDatasetCorrectedTransformation } from "./us-dataset-corrected-transformation-fixture";

type Fixture = Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
/** Real native installed prerequisites; optional capture is distinct from executor application. */
export async function prepareCorrectedCases(
  f: Fixture,
  context: UsDatasetContext,
  capture = true,
  alias?: string,
) {
  const c = await prepareDatasetCorrectedTransformation(f.db, context);
  const native = await new UsDatasetCorrectedTransformationSeedStore(f.db).initialize(context);
  const transformation = await c.stores.journal.readStage(
    context,
    c.header.id,
    "correction_0001",
    "transformation",
  );
  if (!transformation?.receipt) throw new Error("Missing actual corrected Transformation receipt");
  const capturedAt = new Date().toISOString();
  const input = makeUsDatasetCorrectedCasesInput(
    makeUsDatasetReferenceIdentity(c.header.id, c.referenceStage),
    c.amendmentStage,
    transformation,
    {
      capturedAt,
      shiftId: alias ?? randomUUID(),
      numberMonthKey:
        new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
          .format(new Date(capturedAt))
          .toUpperCase() + capturedAt.slice(2, 4),
      numberSeq: 261,
      boxes: makeUsSixMonthSpecialExamples().correction.correctedChain.cases.map((sscc) => ({
        id: randomUUID(),
        deviceBoxId: randomUUID(),
        sscc,
      })),
    },
  );
  const intent: UsDatasetIntent = {
    unitKey: "correction_0001",
    stage: "cases",
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  };
  const stage = capture ? await c.stores.journal.captureIntent(context, c.header.id, intent) : null;
  return { ...c, native, transformation, input, intent, stage };
}

/** Each failpoint is owned by this invocation's randomized disposable child database. */
export async function correctedCasesFault(
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
      "shifts",
      "boxes",
      "traceability_synthetic_case_origins",
      "trace_lot_boxes",
      "tenant_audit_events",
      "trace_lot_box_operations",
      "traceability_demo_dataset_stages",
    ].includes(table)
  )
    throw new Error("Invalid owned Cases fault table");
  const name = "corrected_cases_fault_" + randomUUID().replaceAll("-", "");
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
      throw new AggregateError(errors, "Owned corrected Cases failpoint cleanup failed");
  }
  try {
    await f.pool.query(
      `CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${mutation ?? (corrupt ? "UPDATE shifts SET planned_qty=1;" : `RAISE EXCEPTION 'corrected_cases_sql_fault' USING ERRCODE='${code}';`)} END IF; RETURN NEW; END $$`,
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
export async function corruptCorrectedCases(
  f: Fixture,
  table: string,
  query: string,
  values: readonly unknown[] = [],
) {
  if (
    ![
      "shifts",
      "boxes",
      "traceability_synthetic_case_origins",
      "trace_lot_boxes",
      "trace_lot_box_operations",
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
    if (!changed.rowCount) throw new Error("Missing corrected Cases drift row");
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
