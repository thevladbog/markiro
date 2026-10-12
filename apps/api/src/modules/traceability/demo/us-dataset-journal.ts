import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "./us-demo-canonical.js";
import { and, asc, eq, gt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertUsDemoTarget } from "./us-demo-target.js";
import { parseUsDemoReceipt } from "./us-demo-journal-contract.js";
import type { UsDatasetAtomicStageWork } from "./us-dataset-atomic-stage-contract.js";
import type { UsDemoTransaction } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDatasetDefinition,
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetDefinition,
  type UsDatasetHeader,
  type UsDatasetIntent,
  type UsDatasetPage,
  type UsDatasetReceipt,
  type UsDatasetStage,
  type UsDatasetStageRow,
} from "./us-dataset-contract.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const headers = schema.traceabilityDemoDatasets;
const rows = schema.traceabilityDemoDatasetStages;
const uuid = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .uuid();
const contextSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    expectedDatabaseName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    expectedDatabaseUser: z.literal("markiro_us"),
  })
  .strict();
const cursorSchema = z
  .object({ unitKey: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), stage: z.string() })
  .strict();
function fail(code: string): never {
  throw new Error(code);
}
function same(left: unknown, right: unknown) {
  return canonicalExportDigest(left) === canonicalExportDigest(right);
}
function context(raw: UsDatasetContext): UsDatasetContext {
  if (
    !raw ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    Reflect.ownKeys(raw).length !== Object.keys(raw).length ||
    Object.values(Object.getOwnPropertyDescriptors(raw)).some((d) => !("value" in d))
  )
    return fail("us_dataset_target_invalid");
  const parsed = contextSchema.safeParse(raw);
  if (!parsed.success) return fail("us_dataset_target_invalid");
  return parsed.data;
}

/** Internal bookkeeping only; receipts never certify canonical business state. */
export class UsDatasetJournalStore {
  private readonly definition: UsDatasetDefinition;
  private readonly expectedManifestDigest: string;
  constructor(
    private readonly db: Db,
    definition: UsDatasetDefinition,
  ) {
    this.definition = parseUsDatasetDefinition(definition);
    this.expectedManifestDigest = canonicalExportDigest(this.definition.manifest);
  }

  private async checkedTransactionContext(
    tx: UsDemoTransaction,
    raw: UsDatasetContext,
    mutation = false,
  ): Promise<UsDatasetContext> {
    const value = context(raw);
    const actual = await tx.execute<{ name: string; owner: string }>(
      sql`SELECT current_database() AS name, current_user AS owner`,
    );
    if (
      actual.rows[0]?.name !== value.expectedDatabaseName ||
      actual.rows[0]?.owner !== value.expectedDatabaseUser
    )
      return fail("us_dataset_target_invalid");
    if (mutation)
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${value.tenantId + ":us-processor-demo-v1"}, 0))`,
      );
    await assertUsDemoTarget(tx, this.db, value, () => fail("us_dataset_target_invalid"));
    return value;
  }

  private async transaction<T>(
    raw: UsDatasetContext,
    mutation: boolean,
    action: (tx: Transaction, value: UsDatasetContext) => Promise<T>,
  ): Promise<T> {
    const value = context(raw);
    return this.db.transaction(
      async (tx) => {
        const checked = await this.checkedTransactionContext(tx, value, mutation);
        return action(tx, checked);
      },
      { isolationLevel: mutation ? "read committed" : "repeatable read" },
    );
  }
  private async stored(
    tx: Transaction,
    value: UsDatasetContext,
    lock = false,
  ): Promise<UsDatasetHeader | null> {
    const query = tx.select().from(headers).where(eq(headers.tenantId, value.tenantId)).limit(1);
    const [header] = await (lock ? query.for("update") : query);
    if (!header) return null;
    if (
      !uuid.safeParse(header.id).success ||
      header.version !== this.definition.version ||
      header.definitionDigest !== this.definition.digest ||
      header.createdBy !== value.actorUserId ||
      canonicalExportDigest(header.manifest) !== this.expectedManifestDigest
    )
      return fail("us_dataset_journal_invalid");
    return {
      id: header.id,
      tenantId: header.tenantId,
      version: this.definition.version,
      definitionDigest: header.definitionDigest,
      manifest: this.definition.manifest,
      createdBy: header.createdBy,
    };
  }
  private async required(tx: Transaction, value: UsDatasetContext, id: string, lock = false) {
    const header = await this.stored(tx, value, lock);
    if (!uuid.safeParse(id).success || !header || header.id !== id)
      return fail("us_dataset_conflict");
    return header;
  }
  private unit(unitKey: string, stage: string) {
    const unit = this.definition.units.find((item) => item.key === unitKey);
    if (!unit || !unit.stages.some((item) => item === stage))
      return fail("us_dataset_unit_invalid");
    return unit;
  }
  private parseRow(row: typeof rows.$inferSelect): UsDatasetStageRow {
    try {
      const intent = parseUsDatasetIntent({
        unitKey: row.unitKey,
        stage: row.stage,
        operationKey: row.operationKey,
        inputDigest: row.inputDigest,
        input: row.input,
      });
      this.unit(intent.unitKey, intent.stage);
      const receipt = row.receipt === null ? null : parseUsDemoReceipt(row.receipt);
      if (row.revision !== (receipt === null ? 1 : 2)) return fail("us_dataset_journal_invalid");
      return {
        unitKey: intent.unitKey,
        stage: intent.stage,
        revision: row.revision,
        intent,
        receipt,
      };
    } catch {
      return fail("us_dataset_journal_invalid");
    }
  }
  private scope(value: UsDatasetContext, datasetId: string) {
    return and(eq(rows.tenantId, value.tenantId), eq(rows.datasetId, datasetId));
  }
  private async stage(
    tx: Transaction,
    value: UsDatasetContext,
    datasetId: string,
    unitKey: string,
    stage: UsDatasetStage,
    lock = false,
  ) {
    const query = tx
      .select()
      .from(rows)
      .where(and(this.scope(value, datasetId), eq(rows.unitKey, unitKey), eq(rows.stage, stage)))
      .limit(1);
    const [row] = await (lock ? query.for("update") : query);
    return row ? this.parseRow(row) : null;
  }
  read(value: UsDatasetContext): Promise<UsDatasetHeader | null> {
    return this.transaction(value, false, (tx, checked) => this.stored(tx, checked));
  }
  async readHeaderInTransaction(
    tx: UsDemoTransaction,
    raw: UsDatasetContext,
  ): Promise<UsDatasetHeader | null> {
    const checked = await this.checkedTransactionContext(tx, raw);
    return this.stored(tx, checked);
  }
  async readStage(
    raw: UsDatasetContext,
    datasetId: string,
    unitKey: string,
    stage: UsDatasetStage,
  ): Promise<UsDatasetStageRow | null> {
    const value = context(raw);
    return this.db.transaction(
      (tx) => this.readStageInTransaction(tx, value, datasetId, unitKey, stage),
      { isolationLevel: "repeatable read" },
    );
  }
  async readStageInTransaction(
    tx: UsDemoTransaction,
    raw: UsDatasetContext,
    datasetId: string,
    unitKey: string,
    stage: UsDatasetStage,
  ): Promise<UsDatasetStageRow | null> {
    const checked = await this.checkedTransactionContext(tx, raw);
    await this.required(tx, checked, datasetId);
    this.unit(unitKey, stage);
    return this.stage(tx, checked, datasetId, unitKey, stage);
  }
  async readStageCompletions(
    raw: UsDatasetContext,
    datasetId: string,
    requests: readonly { unitKey: string; stage: UsDatasetStage }[],
  ): Promise<
    ({ unitKey: string; stage: string; revision: number; receiptPresent: boolean } | null)[]
  > {
    const value = context(raw);
    return this.db.transaction(
      async (tx) => {
        const checked = await this.checkedTransactionContext(tx, value);
        await this.required(tx, checked, datasetId);
        const parsed = z.array(cursorSchema).max(256).safeParse(requests);
        if (!parsed.success) return fail("us_dataset_unit_invalid");
        for (const request of parsed.data) this.unit(request.unitKey, request.stage);
        if (parsed.data.length === 0) return [];
        // Eligibility only: downstream payload parsing must not precede partial-stage proofs.
        const selected = await tx
          .select({
            unitKey: rows.unitKey,
            stage: rows.stage,
            revision: rows.revision,
            receiptPresent: sql<unknown>`${rows.receipt} IS NOT NULL`,
          })
          .from(rows)
          .where(
            and(
              this.scope(checked, datasetId),
              or(
                ...parsed.data.map((request) =>
                  and(eq(rows.unitKey, request.unitKey), eq(rows.stage, request.stage)),
                ),
              ),
            ),
          );
        const byPair = new Map(selected.map((row) => [row.unitKey + ":" + row.stage, row]));
        return parsed.data.map((request) => {
          const row = byPair.get(request.unitKey + ":" + request.stage);
          if (!row) return null;
          if (typeof row.receiptPresent !== "boolean") return fail("us_dataset_journal_invalid");
          return { ...request, revision: row.revision, receiptPresent: row.receiptPresent };
        });
      },
      { isolationLevel: "repeatable read" },
    );
  }
  async readStagesInTransaction(
    tx: UsDemoTransaction,
    raw: UsDatasetContext,
    datasetId: string,
    requests: readonly { unitKey: string; stage: UsDatasetStage }[],
  ): Promise<(UsDatasetStageRow | null)[]> {
    const checked = await this.checkedTransactionContext(tx, raw);
    await this.required(tx, checked, datasetId);
    const parsed = z.array(cursorSchema).max(256).safeParse(requests);
    if (!parsed.success) return fail("us_dataset_unit_invalid");
    for (const request of parsed.data) this.unit(request.unitKey, request.stage);
    if (parsed.data.length === 0) return [];
    const selected = await tx
      .select()
      .from(rows)
      .where(
        and(
          this.scope(checked, datasetId),
          or(
            ...parsed.data.map((request) =>
              and(eq(rows.unitKey, request.unitKey), eq(rows.stage, request.stage)),
            ),
          ),
        ),
      );
    const byPair = new Map(selected.map((row) => [row.unitKey + ":" + row.stage, row]));
    return parsed.data.map((request) => {
      const row = byPair.get(request.unitKey + ":" + request.stage);
      return row ? this.parseRow(row) : null;
    });
  }
  initialize(value: UsDatasetContext): Promise<UsDatasetHeader> {
    return this.transaction(value, true, async (tx, checked) => {
      const existing = await this.stored(tx, checked);
      if (existing) return existing;
      // All current US business roots and references: owner/profile facts alone are allowed.
      for (const table of [
        schema.traceabilityDemoSeeds,
        schema.traceabilityParties,
        schema.traceabilityLocations,
        schema.products,
        schema.productTraceabilityProfiles,
        schema.referenceDocuments,
        schema.receivingEventRoots,
        schema.transformationEventRoots,
        schema.shippingEventRoots,
        schema.traceabilityEvents,
        schema.traceabilityLots,
        schema.boxes,
        schema.traceLotBoxes,
        schema.traceabilitySyntheticCaseOrigins,
        schema.traceabilityPlanVersions,
        schema.traceRequests,
        schema.traceExportRuns,
      ] as const) {
        if (
          (
            await tx
              .select({ tenantId: table.tenantId })
              .from(table)
              .where(eq(table.tenantId, checked.tenantId))
              .limit(1)
          ).length
        )
          return fail("us_dataset_freshness_conflict");
      }
      await tx.insert(headers).values({
        tenantId: checked.tenantId,
        version: this.definition.version,
        definitionDigest: this.definition.digest,
        manifest: this.definition.manifest,
        createdBy: checked.actorUserId,
      });
      const result = await this.stored(tx, checked);
      if (!result) return fail("us_dataset_journal_invalid");
      return result;
    });
  }
  readPage(
    value: UsDatasetContext,
    datasetId: string,
    after: { unitKey: string; stage: UsDatasetStage } | null,
    limit: number,
  ): Promise<UsDatasetPage> {
    return this.transaction(value, false, async (tx, checked) => {
      await this.required(tx, checked, datasetId);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return fail("us_dataset_page_invalid");
      if (after !== null) {
        const parsed = cursorSchema.safeParse(after);
        if (
          !parsed.success ||
          !this.definition.units.some(
            (unit) =>
              unit.key === parsed.data.unitKey &&
              unit.stages.some((stage) => stage === parsed.data.stage),
          )
        )
          return fail("us_dataset_page_invalid");
      }
      const selected = await tx
        .select()
        .from(rows)
        .where(
          and(
            this.scope(checked, datasetId),
            after === null
              ? undefined
              : or(
                  gt(rows.unitKey, after.unitKey),
                  and(eq(rows.unitKey, after.unitKey), gt(rows.stage, after.stage)),
                ),
          ),
        )
        .orderBy(asc(rows.unitKey), asc(rows.stage))
        .limit(limit + 1);
      const parsed = selected.map((row) => this.parseRow(row));
      const page = parsed.slice(0, limit);
      const last = page.at(-1);
      return {
        rows: page,
        next: parsed.length > limit && last ? { unitKey: last.unitKey, stage: last.stage } : null,
      };
    });
  }
  captureIntent(
    value: UsDatasetContext,
    datasetId: string,
    raw: UsDatasetIntent,
  ): Promise<UsDatasetStageRow> {
    return this.transaction(value, true, async (tx, checked) => {
      await this.required(tx, checked, datasetId);
      const intent = parseUsDatasetIntent(raw);
      const unit = this.unit(intent.unitKey, intent.stage);
      const existingRows = await tx
        .select()
        .from(rows)
        .where(
          and(
            this.scope(checked, datasetId),
            or(
              and(eq(rows.unitKey, intent.unitKey), eq(rows.stage, intent.stage)),
              eq(rows.operationKey, intent.operationKey),
            ),
          ),
        )
        .limit(2);
      if (existingRows.length) {
        if (existingRows.length !== 1 || !existingRows[0])
          return fail("us_dataset_intent_conflict");
        const existing = this.parseRow(existingRows[0]);
        if (!same(existing.intent, intent)) return fail("us_dataset_intent_conflict");
        return existing;
      }
      const previous = unit.stages[unit.stages.indexOf(intent.stage) - 1];
      if (
        previous &&
        !(await this.stage(tx, checked, datasetId, intent.unitKey, previous))?.receipt
      )
        return fail("us_dataset_predecessor_incomplete");
      const [inserted] = await tx
        .insert(rows)
        .values({
          tenantId: checked.tenantId,
          datasetId,
          unitKey: intent.unitKey,
          stage: intent.stage,
          operationKey: intent.operationKey,
          inputDigest: intent.inputDigest,
          input: intent.input,
        })
        .returning();
      if (!inserted) return fail("us_dataset_journal_invalid");
      return this.parseRow(inserted);
    });
  }
  recordReceipt(
    value: UsDatasetContext,
    datasetId: string,
    expectedRevision: number,
    unitKey: string,
    stage: UsDatasetStage,
    operationKey: string,
    raw: UsDatasetReceipt,
  ): Promise<UsDatasetStageRow> {
    return this.transaction(value, true, async (tx, checked) => {
      await this.required(tx, checked, datasetId);
      this.unit(unitKey, stage);
      if (
        !Number.isInteger(expectedRevision) ||
        expectedRevision < 1 ||
        expectedRevision > 2147483647
      )
        return fail("us_dataset_revision_conflict");
      const receipt = parseUsDemoReceipt(raw);
      const existing = await this.stage(tx, checked, datasetId, unitKey, stage);
      if (
        !uuid.safeParse(operationKey).success ||
        !existing ||
        existing.intent.operationKey !== operationKey
      )
        return fail("us_dataset_receipt_conflict");
      if (existing.receipt !== null) {
        if (!same(existing.receipt, receipt)) return fail("us_dataset_receipt_conflict");
        return existing;
      }
      if (existing.revision !== expectedRevision) return fail("us_dataset_revision_conflict");
      return this.persistPendingReceipt(
        tx,
        checked,
        datasetId,
        existing,
        expectedRevision,
        receipt,
      );
    });
  }

  runAtomicStage(
    value: UsDatasetContext,
    datasetId: string,
    expectedRevision: number,
    raw: UsDatasetIntent,
    work: UsDatasetAtomicStageWork,
  ): Promise<UsDatasetStageRow> {
    return this.transaction(value, true, async (tx, checked) => {
      if (
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 1 ||
        expectedRevision > 2147483647
      )
        return fail("us_dataset_revision_conflict");
      const intent = parseUsDatasetIntent(raw);
      await this.required(tx, checked, datasetId, true);
      const unit = this.unit(intent.unitKey, intent.stage);
      const existing = await this.stage(tx, checked, datasetId, intent.unitKey, intent.stage, true);
      if (!existing || !same(existing.intent, intent)) return fail("us_dataset_intent_conflict");
      const previous = unit.stages[unit.stages.indexOf(intent.stage) - 1];
      if (
        previous &&
        !(await this.stage(tx, checked, datasetId, intent.unitKey, previous, true))?.receipt
      )
        return fail("us_dataset_predecessor_incomplete");
      if (existing.receipt !== null) {
        await work.verify(tx, checked, existing.intent, existing.receipt);
        return existing;
      }
      if (existing.revision !== expectedRevision) return fail("us_dataset_revision_conflict");
      const receipt = parseUsDemoReceipt(await work.apply(tx, checked, existing.intent));
      await work.verify(tx, checked, existing.intent, receipt);
      return this.persistPendingReceipt(
        tx,
        checked,
        datasetId,
        existing,
        expectedRevision,
        receipt,
      );
    });
  }

  private async persistPendingReceipt(
    tx: Transaction,
    value: UsDatasetContext,
    datasetId: string,
    existing: UsDatasetStageRow,
    expectedRevision: number,
    receipt: UsDatasetReceipt,
  ): Promise<UsDatasetStageRow> {
    const updated = await tx
      .update(rows)
      .set({ receipt, revision: 2 })
      .where(
        and(
          this.scope(value, datasetId),
          eq(rows.unitKey, existing.unitKey),
          eq(rows.stage, existing.stage),
          eq(rows.revision, expectedRevision),
          eq(rows.operationKey, existing.intent.operationKey),
        ),
      )
      .returning();
    if (updated.length !== 1 || !updated[0]) return fail("us_dataset_revision_conflict");
    return this.parseRow(updated[0]);
  }
}
