import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UsDatasetAtomicStageWork } from "../src/modules/traceability/demo/us-dataset-atomic-stage-contract";
import {
  parseUsDatasetIntent,
  type UsDatasetContext,
  type UsDatasetIntent,
  type UsDatasetReceipt,
} from "../src/modules/traceability/demo/us-dataset-contract";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
const input = { name: "Synthetic dataset atomic party" };
const newIntent = (): UsDatasetIntent =>
  parseUsDatasetIntent({
    unitKey: "references",
    stage: "references",
    operationKey: randomUUID(),
    input,
    inputDigest: canonicalExportDigest(input),
  });

describe.skipIf(!base)("dataset atomic stage on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: UsDatasetContext;
  let journal: UsDatasetJournalStore;
  let master: UsMasterDataStore;
  let applied: number;
  let verified: number;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDatasetJournalFixture(base);
    console.info(`Owned dataset atomic database: ${f.databaseName}`);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
    journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
    master = new UsMasterDataStore(f.db);
    applied = 0;
    verified = 0;
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  const work: UsDatasetAtomicStageWork = {
    async apply(tx, checked, intent) {
      applied++;
      expect(checked).toEqual(context);
      const party = await master.createPartyInTransaction(
        tx,
        checked.tenantId,
        checked.actorUserId,
        intent.input,
        intent.operationKey,
      );
      const result = { party };
      return { recordIds: [party.id], result, resultDigest: canonicalExportDigest(result) };
    },
    async verify(tx, checked, intent, receipt) {
      verified++;
      expect(checked).toEqual(context);
      const id = receipt.recordIds[0];
      if (!id || receipt.recordIds.length !== 1)
        throw new Error("synthetic_dataset_canonical_mismatch");
      const party = await master.getPartyInTransaction(
        tx,
        checked.tenantId,
        checked.actorUserId,
        id,
      );
      if (party.name !== intent.input.name || !isDeepStrictEqual(receipt.result, { party }))
        throw new Error("synthetic_dataset_canonical_mismatch");
    },
  };
  async function capture(intent = newIntent()) {
    const header = await journal.initialize(context);
    const captured = await journal.captureIntent(context, header.id, intent);
    return { header, captured, intent };
  }
  async function denied(action: () => Promise<unknown>, code: string, callbacks = false) {
    const before = await f.snapshot();
    await expect(action()).rejects.toThrow(code);
    expect(await f.snapshot()).toEqual(before);
    if (!callbacks) {
      expect(applied).toBe(0);
      expect(verified).toBe(0);
    }
  }
  async function assertCommitted(intent: UsDatasetIntent, receipt: UsDatasetReceipt | null) {
    if (!receipt) throw new Error("Missing committed receipt");
    const parties = await f.db.select().from(schema.traceabilityParties);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      id: receipt.recordIds[0],
      tenantId: context.tenantId,
      name: "Synthetic dataset atomic party",
      archived: false,
    });
    const audits = await f.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.action, "traceability.party.created"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      organizationId: context.tenantId,
      actorUserId: context.actorUserId,
      action: "traceability.party.created",
      outcome: "success",
      targetType: "traceability_party",
      targetId: receipt.recordIds[0],
      requestId: intent.operationKey,
      before: null,
      after: receipt.result.party,
    });
    expect(audits[0]?.after).toEqual(receipt.result.party);
    expect(await f.db.select().from(schema.traceabilityDemoDatasets)).toHaveLength(1);
    expect(await f.db.select().from(schema.traceabilityDemoDatasetStages)).toMatchObject([
      { revision: 2, receipt },
    ]);
    expect(await f.db.select().from(schema.traceabilityDemoSeeds)).toEqual([]);
  }

  it("commits real party, exact audit and receipt once; exact stale retries verify canonical facts", async () => {
    const { header, captured, intent } = await capture();
    const first = await journal.runAtomicStage(context, header.id, captured.revision, intent, work);
    expect(first).toEqual({
      unitKey: "references",
      stage: "references",
      revision: 2,
      intent,
      receipt: expect.any(Object),
    });
    await assertCommitted(intent, first.receipt);
    const saved = await f.snapshot();
    for (const revision of [1, 2, 2147483647])
      expect(await journal.runAtomicStage(context, header.id, revision, intent, work)).toEqual(
        first,
      );
    expect(await f.snapshot()).toEqual(saved);
    expect(applied).toBe(1);
    expect(verified).toBe(4);
  });
  it("recovers a discarded committed reply with a new journal and master store", async () => {
    const { header, intent } = await capture();
    await journal.runAtomicStage(context, header.id, 1, intent, work);
    const saved = await f.snapshot();
    journal = new UsDatasetJournalStore(f.db, usSixMonthDefinition);
    master = new UsMasterDataStore(f.db);
    const persisted = (await journal.readPage(context, header.id, null, 1)).rows[0];
    expect(await journal.runAtomicStage(context, header.id, 1, intent, work)).toEqual(persisted);
    expect(await f.snapshot()).toEqual(saved);
    if (!persisted) throw new Error("Missing stage");
    await assertCommitted(intent, persisted.receipt);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
    console.info("Dataset lost reply persisted digests", {
      party: saved.traceability_parties,
      audit: saved.tenant_audit_events,
      header: saved.traceability_demo_datasets,
      stage: saved.traceability_demo_dataset_stages,
    });
  });
  it("serializes identical concurrent calls into one party, audit and receipt", async () => {
    const { header, intent } = await capture();
    const results = await Promise.all([
      journal.runAtomicStage(context, header.id, 1, intent, work),
      journal.runAtomicStage(context, header.id, 1, intent, work),
    ]);
    expect(results[0]).toEqual(results[1]);
    if (!results[0]) throw new Error("Missing committed stage");
    await assertCommitted(intent, results[0].receipt);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
  });
  it("rejects a changed-intent concurrent loser without extra business writes", async () => {
    const { header, intent } = await capture();
    const otherInput = { name: "Changed synthetic party" };
    const changed = {
      ...intent,
      input: otherInput,
      inputDigest: canonicalExportDigest(otherInput),
    };
    const results = await Promise.allSettled([
      journal.runAtomicStage(context, header.id, 1, intent, work),
      journal.runAtomicStage(context, header.id, 1, changed, work),
    ]);
    expect(results[0]?.status).toBe("fulfilled");
    expect(results[1]).toMatchObject({
      status: "rejected",
      reason: new Error("us_dataset_intent_conflict"),
    });
    const winner = results[0];
    if (winner?.status !== "fulfilled") throw new Error("Missing winner");
    await assertCommitted(intent, winner.value.receipt);
    expect(applied).toBe(1);
    expect(verified).toBe(1);
  });
  it("replays exact stale intent after unrelated unit capture without changing either row", async () => {
    const { header, intent } = await capture();
    const first = await journal.runAtomicStage(context, header.id, 1, intent, work);
    const unit = usSixMonthDefinition.units.find((item) => item.kind === "chain");
    if (!unit) throw new Error("Missing recipe chain");
    await journal.captureIntent(context, header.id, {
      ...newIntent(),
      unitKey: unit.key,
      stage: "receiving",
    });
    const saved = await f.snapshot();
    expect(await journal.runAtomicStage(context, header.id, 1, intent, work)).toEqual(first);
    expect(await f.snapshot()).toEqual(saved);
    expect(await f.db.select().from(schema.traceabilityDemoDatasetStages)).toHaveLength(2);
  });
  it("does not initialize missing datasets or capture missing intents", async () => {
    const intent = newIntent();
    await denied(
      () => journal.runAtomicStage(context, randomUUID(), 1, intent, work),
      "us_dataset_conflict",
    );
    const header = await journal.initialize(context);
    await denied(
      () => journal.runAtomicStage(context, header.id, 1, intent, work),
      "us_dataset_intent_conflict",
    );
  });
  it.each(["invalid", "foreign"])("rejects %s dataset before callbacks", async (kind) => {
    const { intent } = await capture();
    await denied(
      () =>
        journal.runAtomicStage(context, kind === "invalid" ? "bad" : randomUUID(), 1, intent, work),
      "us_dataset_conflict",
    );
  });
  it.each(["operation", "unit", "stage", "input", "unknown unit", "unknown stage"])(
    "rejects changed %s before callbacks",
    async (kind) => {
      const { header, intent } = await capture();
      const chain = usSixMonthDefinition.units.find((unit) => unit.kind === "chain");
      if (!chain) throw new Error("Missing recipe chain");
      const changedInput = { name: "Other synthetic party" };
      const changed: UsDatasetIntent = {
        ...intent,
        ...(kind === "operation" ? { operationKey: randomUUID() } : {}),
        ...(kind === "unit" ? { unitKey: chain.key, stage: "receiving" as const } : {}),
        ...(kind === "stage" ? { stage: "receiving" as const } : {}),
        ...(kind === "unknown unit" ? { unitKey: "unknown" } : {}),
        ...(kind === "unknown stage" ? { stage: "plan" as const } : {}),
        ...(kind === "input"
          ? { input: changedInput, inputDigest: canonicalExportDigest(changedInput) }
          : {}),
      };
      await denied(
        () => journal.runAtomicStage(context, header.id, 1, changed, work),
        ["stage", "unknown unit", "unknown stage"].includes(kind)
          ? "us_dataset_unit_invalid"
          : "us_dataset_intent_conflict",
      );
    },
  );
  it.each([NaN, Infinity, 0, -1, 1.5, 2147483648, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid revision %s even on completed replay",
    async (revision) => {
      const { header, intent } = await capture();
      await denied(
        () => journal.runAtomicStage(context, header.id, revision, intent, work),
        "us_dataset_revision_conflict",
      );
      await journal.runAtomicStage(context, header.id, 1, intent, work);
      applied = 0;
      verified = 0;
      await denied(
        () => journal.runAtomicStage(context, header.id, revision, intent, work),
        "us_dataset_revision_conflict",
      );
    },
  );
  it.each([2, 2147483647])("requires actual pending revision instead of %s", async (revision) => {
    const { header, intent } = await capture();
    await denied(
      () => journal.runAtomicStage(context, header.id, revision, intent, work),
      "us_dataset_revision_conflict",
    );
  });
  it.each([
    "database",
    "actual user",
    "expected user",
    "tenant",
    "actor",
    "revoked",
    "provenance",
    "profile",
  ])("reloads %s target facts on completed replay before callbacks", async (kind) => {
    const { header, intent } = await capture();
    await journal.runAtomicStage(context, header.id, 1, intent, work);
    applied = 0;
    verified = 0;
    const target = {
      ...context,
      ...(kind === "database" ? { expectedDatabaseName: "markiro_us_dev" } : {}),
      ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
      ...(kind === "actor" ? { actorUserId: randomUUID() } : {}),
    };
    if (kind === "revoked") await f.db.update(schema.member).set({ role: "traceability_qa" });
    if (kind === "provenance") await f.db.update(schema.organization).set({ metadata: "corrupt" });
    if (kind === "profile")
      await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
    const selected =
      kind === "actual user"
        ? new UsDatasetJournalStore(await f.alternateRole(), usSixMonthDefinition)
        : journal;
    if (kind === "expected user")
      Object.assign(target, { expectedDatabaseUser: "pg_read_all_data" });
    await denied(
      () => selected.runAtomicStage(target, header.id, 1, intent, work),
      "us_dataset_target_invalid",
    );
  });
  it.each(["header", "owner", "manifest", "input", "digest", "revision", "receipt"])(
    "rejects corrupt persisted %s before callbacks",
    async (kind) => {
      const { header, intent } = await capture();
      if (kind === "header")
        await f.db
          .update(schema.traceabilityDemoDatasets)
          .set({ definitionDigest: "a".repeat(64) });
      if (kind === "owner")
        await f.db.update(schema.traceabilityDemoDatasets).set({ createdBy: randomUUID() });
      if (kind === "manifest")
        await f.db.update(schema.traceabilityDemoDatasets).set({ manifest: { synthetic: false } });
      if (kind === "input")
        await f.db.update(schema.traceabilityDemoDatasetStages).set({ input: { name: "Corrupt" } });
      if (kind === "digest")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ inputDigest: "a".repeat(64) });
      if (kind === "receipt")
        await f.db.update(schema.traceabilityDemoDatasetStages).set({
          revision: 2,
          receipt: { recordIds: [], result: {}, resultDigest: "a".repeat(64) },
        });
      if (kind === "revision") {
        await f.pool.query(
          "ALTER TABLE traceability_demo_dataset_stages DROP CONSTRAINT traceability_demo_dataset_stages_revision_valid, DROP CONSTRAINT traceability_demo_dataset_stages_completion_valid",
        );
        await f.db.update(schema.traceabilityDemoDatasetStages).set({ revision: 7 });
      }
      try {
        await denied(
          () => journal.runAtomicStage(context, header.id, 1, intent, work),
          "us_dataset_journal_invalid",
        );
      } finally {
        if (kind === "revision") {
          await f.db.update(schema.traceabilityDemoDatasetStages).set({ revision: 1 });
          await f.pool.query(
            "ALTER TABLE traceability_demo_dataset_stages ADD CONSTRAINT traceability_demo_dataset_stages_revision_valid CHECK (revision BETWEEN 1 AND 2), ADD CONSTRAINT traceability_demo_dataset_stages_completion_valid CHECK ((revision = 1 AND receipt IS NULL) OR (revision = 2 AND receipt IS NOT NULL))",
          );
        }
      }
    },
  );
  it.each(["operation", "digest", "extra", "oversized"])(
    "rejects malformed raw intent %s without callbacks",
    async (kind) => {
      const { header, intent } = await capture();
      const raw = {
        ...intent,
        ...(kind === "operation" ? { operationKey: "invalid" } : {}),
        ...(kind === "digest" ? { inputDigest: "a".repeat(64) } : {}),
        ...(kind === "extra" ? { extra: true } : {}),
        ...(kind === "oversized" ? { input: { name: "x".repeat(256 * 1024) } } : {}),
      };
      await denied(
        () => journal.runAtomicStage(context, header.id, 1, raw, work),
        kind === "digest"
          ? "us_dataset_intent_digest_mismatch"
          : kind === "oversized"
            ? "us_demo_json_too_large"
            : "us_dataset_intent_invalid",
      );
    },
  );
  it.each(["absent", "pending", "corrupt"])(
    "requires a valid predecessor receipt when %s",
    async (kind) => {
      const { header } = await capture();
      const unit = usSixMonthDefinition.units.find((item) => item.kind === "chain");
      if (!unit) throw new Error("Missing recipe chain");
      const previous = { ...newIntent(), unitKey: unit.key, stage: "receiving" as const };
      await journal.captureIntent(context, header.id, previous);
      const result = { synthetic: true };
      await journal.recordReceipt(
        context,
        header.id,
        1,
        unit.key,
        "receiving",
        previous.operationKey,
        { recordIds: [], result, resultDigest: canonicalExportDigest(result) },
      );
      const intent = { ...newIntent(), unitKey: unit.key, stage: "transformation" as const };
      await journal.captureIntent(context, header.id, intent);
      const completed = await journal.runAtomicStage(context, header.id, 1, intent, work);
      expect(completed.revision).toBe(2);
      const saved = await f.snapshot();
      expect(await journal.runAtomicStage(context, header.id, 1, intent, work)).toEqual(completed);
      expect(await f.snapshot()).toEqual(saved);
      applied = 0;
      verified = 0;
      if (kind === "absent")
        await f.db
          .delete(schema.traceabilityDemoDatasetStages)
          .where(eq(schema.traceabilityDemoDatasetStages.stage, "receiving"));
      if (kind === "pending")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ revision: 1, receipt: null })
          .where(eq(schema.traceabilityDemoDatasetStages.stage, "receiving"));
      if (kind === "corrupt")
        await f.db
          .update(schema.traceabilityDemoDatasetStages)
          .set({ receipt: { recordIds: [], result: {}, resultDigest: "a".repeat(64) } })
          .where(eq(schema.traceabilityDemoDatasetStages.stage, "receiving"));
      await denied(
        () => journal.runAtomicStage(context, header.id, 1, intent, work),
        kind === "corrupt" ? "us_dataset_journal_invalid" : "us_dataset_predecessor_incomplete",
      );
      // The same predecessor rule also gates a pending current stage.
      await f.db
        .update(schema.traceabilityDemoDatasetStages)
        .set({ revision: 1, receipt: null })
        .where(eq(schema.traceabilityDemoDatasetStages.stage, "transformation"));
      await denied(
        () => journal.runAtomicStage(context, header.id, 1, intent, work),
        kind === "corrupt" ? "us_dataset_journal_invalid" : "us_dataset_predecessor_incomplete",
      );
    },
  );
  it.each(["missing", "edited"])(
    "rejects %s actual party on replay without apply or repair",
    async (kind) => {
      const { header, intent } = await capture();
      await journal.runAtomicStage(context, header.id, 1, intent, work);
      if (kind === "missing") await f.db.delete(schema.traceabilityParties);
      else
        await f.db.update(schema.traceabilityParties).set({ legalName: "Changed canonical party" });
      applied = 0;
      verified = 0;
      await denied(
        () => journal.runAtomicStage(context, header.id, 1, intent, work),
        kind === "missing" ? "Not Found" : "synthetic_dataset_canonical_mismatch",
        true,
      );
      expect(applied).toBe(0);
      expect(verified).toBe(1);
    },
  );
  it.each([
    "apply",
    "audit",
    "invalid receipt",
    "digest mismatch",
    "oversized receipt",
    "verifier",
    "receipt write",
  ])(
    "rolls back every persisted table after %s failure then retries successfully",
    async (kind) => {
      const { header, intent } = await capture();
      const trigger = kind === "audit" || kind === "receipt write";
      const table = kind === "audit" ? "tenant_audit_events" : "traceability_demo_dataset_stages";
      if (trigger) {
        await f.pool.query(
          "CREATE FUNCTION synthetic_dataset_atomic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_dataset_atomic_failure'; END $$",
        );
        await f.pool.query(
          `CREATE TRIGGER synthetic_dataset_atomic_failure BEFORE ${kind === "audit" ? "INSERT" : "UPDATE"} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_dataset_atomic_failure()`,
        );
      }
      const failing: UsDatasetAtomicStageWork = {
        async apply(tx, checked, value) {
          const receipt = await work.apply(tx, checked, value);
          if (kind === "apply") throw new Error("synthetic_dataset_apply_failure");
          if (kind === "invalid receipt") return { ...receipt, recordIds: ["invalid"] };
          if (kind === "digest mismatch") return { ...receipt, resultDigest: "a".repeat(64) };
          if (kind === "oversized receipt")
            return { ...receipt, result: { name: "x".repeat(256 * 1024) } };
          return receipt;
        },
        async verify(tx, checked, value, receipt) {
          await work.verify(tx, checked, value, receipt);
          if (kind === "verifier") throw new Error("synthetic_dataset_verifier_failure");
        },
      };
      try {
        const before = await f.snapshot();
        const operation = journal.runAtomicStage(context, header.id, 1, intent, failing);
        if (trigger) await expect(operation).rejects.toMatchObject({ cause: { code: "P0001" } });
        else
          await expect(operation).rejects.toThrow(
            kind === "apply"
              ? "synthetic_dataset_apply_failure"
              : kind === "verifier"
                ? "synthetic_dataset_verifier_failure"
                : kind === "invalid receipt"
                  ? "us_demo_receipt_invalid"
                  : kind === "digest mismatch"
                    ? "us_demo_receipt_digest_mismatch"
                    : "us_demo_json_too_large",
          );
        expect(await f.snapshot()).toEqual(before);
        expect(await f.db.select().from(schema.traceabilityParties)).toEqual([]);
        expect(await f.db.select().from(schema.traceabilityDemoDatasetStages)).toMatchObject([
          { revision: 1, receipt: null, operationKey: intent.operationKey },
        ]);
        console.info(`Dataset atomic rollback verified: ${kind}`);
      } finally {
        if (trigger) {
          await f.pool.query(`DROP TRIGGER synthetic_dataset_atomic_failure ON ${table}`);
          await f.pool.query("DROP FUNCTION synthetic_dataset_atomic_failure()");
        }
      }
      const committed = await journal.runAtomicStage(context, header.id, 1, intent, work);
      await assertCommitted(intent, committed.receipt);
    },
  );
});
