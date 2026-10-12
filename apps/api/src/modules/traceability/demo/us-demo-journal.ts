import { schema, type Db } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { assertUsDemoTarget } from "./us-demo-target.js";
import { US_DEMO_VERSION, usDemoDefinitionDigest } from "./us-demo-definition.js";
import type { UsDemoAtomicStageWork } from "./us-demo-atomic-stage-contract.js";
import {
  parseUsDemoIntent,
  parseUsDemoReceipt,
  type UsDemoIntent,
  type UsDemoJournal,
  type UsDemoJournalContext,
  type UsDemoReceipt,
  type UsDemoStage,
} from "./us-demo-journal-contract.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const stages = [
  "references",
  "receiving",
  "transformation",
  "cases",
  "shipping",
  "trace_readiness",
  "plan",
  "request",
  "package",
] as const;
const uuid = z
  .string()
  .regex(/^[0-9a-f-]{36}$/)
  .uuid();
const revision = z.number().int().min(1).max(2147483647);
const contextSchema = z
  .object({
    tenantId: uuid,
    actorUserId: uuid,
    expectedDatabaseName: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/),
    expectedDatabaseUser: z.literal("markiro_us"),
  })
  .strict();
const seeds = schema.traceabilityDemoSeeds;
const rows = schema.traceabilityDemoSeedStages;

function fail(code: string): never {
  throw new Error(code);
}
function parseContext(raw: UsDemoJournalContext): UsDemoJournalContext {
  if (raw === null || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype)
    return fail("us_demo_target_invalid");
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (
    Reflect.ownKeys(raw).length !== Object.keys(raw).length ||
    Object.values(descriptors).some((descriptor) => !("value" in descriptor))
  )
    return fail("us_demo_target_invalid");
  const result = contextSchema.safeParse(raw);
  if (!result.success) return fail("us_demo_target_invalid");
  return result.data;
}
function same(left: UsDemoIntent | UsDemoReceipt, right: UsDemoIntent | UsDemoReceipt): boolean {
  return canonicalExportDigest(left) === canonicalExportDigest(right);
}

/** Internal bookkeeping only. Trusted callers supply an already validated target
 * identity; this is neither an environment validator nor business orchestration.
 */
export class UsDemoJournalStore {
  constructor(private readonly db: Db) {}

  private async transaction<T>(
    raw: UsDemoJournalContext,
    mutation: boolean,
    action: (tx: Transaction, context: UsDemoJournalContext) => Promise<T>,
  ): Promise<T> {
    const context = parseContext(raw);
    return this.db.transaction(
      async (tx) => {
        const actual = await tx.execute<{ name: string; owner: string }>(
          sql`SELECT current_database() AS name, current_user AS owner`,
        );
        if (
          actual.rows[0]?.name !== context.expectedDatabaseName ||
          actual.rows[0]?.owner !== context.expectedDatabaseUser
        )
          return fail("us_demo_target_invalid");
        if (mutation)
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${context.tenantId + ":" + US_DEMO_VERSION}, 0))`);
        await assertUsDemoTarget(tx, this.db, context, () => fail("us_demo_target_invalid"));
        return action(tx, context);
      },
      { isolationLevel: mutation ? "read committed" : "repeatable read" },
    );
  }

  private async stored(
    tx: Transaction,
    context: UsDemoJournalContext,
    lock: boolean,
  ): Promise<UsDemoJournal | null> {
    const query = tx.select().from(seeds).where(eq(seeds.tenantId, context.tenantId));
    const headers = await (lock ? query.for("update") : query);
    if (headers.length === 0) return null;
    const header = headers[0];
    if (
      headers.length !== 1 ||
      !header ||
      !uuid.safeParse(header.id).success ||
      header.scenarioVersion !== US_DEMO_VERSION ||
      header.definitionDigest !== usDemoDefinitionDigest ||
      header.createdBy !== context.actorUserId ||
      !revision.safeParse(header.revision).success
    )
      return fail("us_demo_journal_invalid");
    const storedRows = await tx
      .select()
      .from(rows)
      .where(and(eq(rows.tenantId, context.tenantId), eq(rows.seedId, header.id)));
    const parsed: UsDemoJournal["stages"][number][] = [];
    const operationKeys = new Set<string>();
    const stageNames = new Set<UsDemoStage>();
    for (const row of storedRows) {
      let intent: UsDemoIntent;
      let receipt: UsDemoReceipt | null;
      try {
        intent = parseUsDemoIntent({
          stage: row.stage,
          operationKey: row.operationKey,
          inputDigest: row.inputDigest,
          input: row.input,
        });
        receipt = row.receipt === null ? null : parseUsDemoReceipt(row.receipt);
      } catch {
        // Only stored evidence parsing is sanitized; no DB operation lives here.
        return fail("us_demo_journal_invalid");
      }
      if (
        row.revision !== (receipt === null ? 1 : 2) ||
        operationKeys.has(intent.operationKey) ||
        stageNames.has(intent.stage)
      )
        return fail("us_demo_journal_invalid");
      operationKeys.add(intent.operationKey);
      stageNames.add(intent.stage);
      parsed.push({ stage: intent.stage, revision: row.revision, intent, receipt });
    }
    if (header.revision !== 1 + parsed.reduce((total, stage) => total + stage.revision, 0))
      return fail("us_demo_journal_invalid");
    parsed.sort((left, right) => stages.indexOf(left.stage) - stages.indexOf(right.stage));
    return {
      id: header.id,
      tenantId: header.tenantId,
      scenarioVersion: US_DEMO_VERSION,
      definitionDigest: header.definitionDigest,
      revision: header.revision,
      stages: parsed,
    };
  }

  read(context: UsDemoJournalContext): Promise<UsDemoJournal | null> {
    return this.transaction(context, false, (tx, value) => this.stored(tx, value, false));
  }

  initialize(context: UsDemoJournalContext): Promise<UsDemoJournal> {
    return this.transaction(context, true, async (tx, value) => {
      const existing = await this.stored(tx, value, true);
      if (existing) return existing;
      await tx.insert(seeds).values({
        tenantId: value.tenantId,
        scenarioVersion: US_DEMO_VERSION,
        definitionDigest: usDemoDefinitionDigest,
        createdBy: value.actorUserId,
      });
      const created = await this.stored(tx, value, true);
      if (!created) return fail("us_demo_journal_invalid");
      return created;
    });
  }

  captureIntent(
    context: UsDemoJournalContext,
    seedId: string,
    expectedRevision: number,
    raw: UsDemoIntent,
  ): Promise<UsDemoJournal> {
    return this.transaction(context, true, async (tx, value) => {
      if (!revision.safeParse(expectedRevision).success) return fail("us_demo_revision_conflict");
      const intent = parseUsDemoIntent(raw);
      const current = await this.stored(tx, value, true);
      if (!uuid.safeParse(seedId).success || !current || current.id !== seedId)
        return fail("us_demo_seed_conflict");
      const existing = current.stages.find(
        (stage) =>
          stage.stage === intent.stage || stage.intent.operationKey === intent.operationKey,
      );
      if (existing) {
        if (!same(existing.intent, intent)) return fail("us_demo_intent_conflict");
        return current; // Committed exact replay precedes stale CAS.
      }
      if (current.revision !== expectedRevision || current.revision === 2147483647)
        return fail("us_demo_revision_conflict");
      await tx.insert(rows).values({
        tenantId: value.tenantId,
        seedId,
        stage: intent.stage,
        operationKey: intent.operationKey,
        inputDigest: intent.inputDigest,
        input: intent.input,
      });
      await tx
        .update(seeds)
        .set({ revision: sql`${seeds.revision} + 1` })
        .where(
          and(
            eq(seeds.tenantId, value.tenantId),
            eq(seeds.id, seedId),
            eq(seeds.revision, expectedRevision),
          ),
        );
      const recorded = await this.stored(tx, value, true);
      if (!recorded) return fail("us_demo_journal_invalid");
      return recorded;
    });
  }

  recordReceipt(
    context: UsDemoJournalContext,
    seedId: string,
    expectedRevision: number,
    stage: UsDemoStage,
    operationKey: string,
    raw: UsDemoReceipt,
  ): Promise<UsDemoJournal> {
    return this.transaction(context, true, async (tx, value) => {
      if (!revision.safeParse(expectedRevision).success) return fail("us_demo_revision_conflict");
      const receipt = parseUsDemoReceipt(raw);
      const current = await this.stored(tx, value, true);
      if (!uuid.safeParse(seedId).success || !current || current.id !== seedId)
        return fail("us_demo_seed_conflict");
      const existing = current.stages.find((item) => item.stage === stage);
      if (
        !z.enum(stages).safeParse(stage).success ||
        !uuid.safeParse(operationKey).success ||
        !existing ||
        existing.intent.operationKey !== operationKey
      )
        return fail("us_demo_receipt_conflict");
      if (existing.receipt) {
        if (!same(existing.receipt, receipt)) return fail("us_demo_receipt_conflict");
        return current;
      }
      if (current.revision !== expectedRevision || current.revision === 2147483647)
        return fail("us_demo_revision_conflict");
      return this.persistReceipt(tx, value, seedId, expectedRevision, stage, receipt);
    });
  }

  runAtomicStage(
    context: UsDemoJournalContext,
    seedId: string,
    expectedRevision: number,
    raw: UsDemoIntent,
    work: UsDemoAtomicStageWork,
  ): Promise<UsDemoJournal> {
    return this.transaction(context, true, async (tx, value) => {
      if (!revision.safeParse(expectedRevision).success) return fail("us_demo_revision_conflict");
      const intent = parseUsDemoIntent(raw);
      const current = await this.stored(tx, value, true);
      if (!uuid.safeParse(seedId).success || !current || current.id !== seedId)
        return fail("us_demo_seed_conflict");
      const existing = current.stages.find((item) => item.stage === intent.stage);
      if (!existing || !same(existing.intent, intent)) return fail("us_demo_intent_conflict");
      if (existing.receipt !== null) {
        await work.verify(tx, value, existing.intent, existing.receipt);
        return current;
      }
      if (current.revision !== expectedRevision || current.revision === 2147483647)
        return fail("us_demo_revision_conflict");
      const receipt = parseUsDemoReceipt(await work.apply(tx, value, existing.intent));
      await work.verify(tx, value, existing.intent, receipt);
      return this.persistReceipt(tx, value, seedId, expectedRevision, existing.stage, receipt);
    });
  }

  private async persistReceipt(
    tx: Transaction,
    context: UsDemoJournalContext,
    seedId: string,
    expectedRevision: number,
    stage: UsDemoStage,
    receipt: UsDemoReceipt,
  ): Promise<UsDemoJournal> {
    await tx
      .update(rows)
      .set({ receipt, revision: sql`${rows.revision} + 1` })
      .where(
        and(eq(rows.tenantId, context.tenantId), eq(rows.seedId, seedId), eq(rows.stage, stage)),
      );
    await tx
      .update(seeds)
      .set({ revision: sql`${seeds.revision} + 1` })
      .where(
        and(
          eq(seeds.tenantId, context.tenantId),
          eq(seeds.id, seedId),
          eq(seeds.revision, expectedRevision),
        ),
      );
    const recorded = await this.stored(tx, context, true);
    if (!recorded) return fail("us_demo_journal_invalid");
    return recorded;
  }
}
