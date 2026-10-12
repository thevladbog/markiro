import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createDb, schema } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsDemoJournalStore } from "../src/modules/traceability/demo/us-demo-journal";
import type {
  UsDemoAtomicStageWork,
  UsDemoTransaction,
} from "../src/modules/traceability/demo/us-demo-atomic-stage-contract";
import {
  type UsDemoIntent,
  type UsDemoJournalContext,
  type UsDemoReceipt,
} from "../src/modules/traceability/demo/us-demo-journal-contract";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { createUsDemoJournalFixture } from "./support/us-demo-journal-fixture";

type Transaction = UsDemoTransaction;
const base = process.env.US_TEST_DATABASE_URL;
const input = { name: "Synthetic atomic party" };
const newIntent = (): UsDemoIntent => ({
  stage: "references",
  operationKey: randomUUID(),
  input,
  inputDigest: canonicalExportDigest(input),
});

describe.skipIf(!base)("US demo atomic stage on owned PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof createUsDemoJournalFixture>>;
  let context: UsDemoJournalContext;
  let store: UsDemoJournalStore;
  let master: UsMasterDataStore;
  let applied: number;
  let verified: number;

  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated US database");
    f = await createUsDemoJournalFixture(base);
    console.info(`Owned atomic database: ${f.databaseName}`);
    store = new UsDemoJournalStore(f.db);
    master = new UsMasterDataStore(f.db);
  }, 60_000);
  beforeEach(async () => {
    context = await f.provision();
    applied = 0;
    verified = 0;
  }, 60_000);
  afterAll(async () => {
    if (!f || !base) return;
    await f.close();
    const verifier = createDb(base);
    try {
      const remaining = await verifier.pool.query(
        "SELECT datname FROM pg_database WHERE datname = $1",
        [f.databaseName],
      );
      expect(remaining.rows).toEqual([]);
      console.info(`Disposed atomic database verified absent: ${f.databaseName}`);
    } finally {
      await verifier.pool.end();
    }
  });

  const work: UsDemoAtomicStageWork = {
    async apply(tx: Transaction, checked: UsDemoJournalContext, intent: UsDemoIntent) {
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
    async verify(
      tx: Transaction,
      checked: UsDemoJournalContext,
      intent: UsDemoIntent,
      receipt: UsDemoReceipt,
    ) {
      verified++;
      expect(checked).toEqual(context);
      const id = receipt.recordIds[0];
      if (!id || receipt.recordIds.length !== 1) throw new Error("synthetic_canonical_mismatch");
      const party = await master.getPartyInTransaction(
        tx,
        checked.tenantId,
        checked.actorUserId,
        id,
      );
      if (party.name !== intent.input.name || !isDeepStrictEqual(receipt.result, { party }))
        throw new Error("synthetic_canonical_mismatch");
    },
  };

  async function capture(intent = newIntent()) {
    const first = await store.initialize(context);
    const captured = await store.captureIntent(context, first.id, first.revision, intent);
    return { intent, captured };
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
  async function assertCommitted(intent: UsDemoIntent, receipt: UsDemoReceipt | null | undefined) {
    if (!receipt) throw new Error("Missing committed receipt");
    const parties = await f.db.select().from(schema.traceabilityParties);
    expect(parties).toHaveLength(1);
    expect(parties[0]).toMatchObject({
      id: receipt.recordIds[0],
      tenantId: context.tenantId,
      name: "Synthetic atomic party",
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
    expect(await f.db.select().from(schema.traceabilityDemoSeeds)).toHaveLength(1);
    expect(await f.db.select().from(schema.traceabilityDemoSeedStages)).toHaveLength(1);
  }

  it("commits actual party, exact audit and receipt once; stale retry verifies canonical data", async () => {
    const { captured, intent } = await capture();
    const recorded = await store.runAtomicStage(
      context,
      captured.id,
      captured.revision,
      intent,
      work,
    );
    expect(recorded.revision).toBe(3);
    expect(recorded.revision).toBe(captured.revision + 1);
    expect(recorded.stages).toEqual([
      { stage: "references", revision: 2, intent, receipt: expect.any(Object) },
    ]);
    await assertCommitted(intent, recorded.stages[0]?.receipt);
    const afterFirstCommit = await f.snapshot();
    expect(
      await store.runAtomicStage(context, captured.id, captured.revision, intent, work),
    ).toEqual(recorded);
    expect(await f.snapshot()).toEqual(afterFirstCommit);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
  });

  it("recovers a discarded real committed reply with exact full-row digests", async () => {
    const { captured, intent } = await capture();
    await store.runAtomicStage(context, captured.id, captured.revision, intent, work);
    const canonical = await store.read(context);
    const afterFirstCommit = await f.snapshot();
    expect(
      await store.runAtomicStage(context, captured.id, captured.revision, intent, work),
    ).toEqual(canonical);
    expect(await f.snapshot()).toEqual(afterFirstCommit);
    await assertCommitted(intent, canonical?.stages[0]?.receipt);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
    console.info("Lost-reply persisted digests", {
      party: afterFirstCommit.traceability_parties,
      audit: afterFirstCommit.tenant_audit_events,
      header: afterFirstCommit.traceability_demo_seeds,
      stage: afterFirstCommit.traceability_demo_seed_stages,
    });
  });

  it("serializes two identical concurrent calls into one party, receipt and exact audit", async () => {
    const { captured, intent } = await capture();
    const outcomes = await Promise.all([
      store.runAtomicStage(context, captured.id, captured.revision, intent, work),
      store.runAtomicStage(context, captured.id, captured.revision, intent, work),
    ]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]?.revision).toBe(3);
    await assertCommitted(intent, outcomes[0]?.stages[0]?.receipt);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
  });

  it("returns the current journal after later intent capture on exact stale replay", async () => {
    const { captured, intent } = await capture();
    const committed = await store.runAtomicStage(
      context,
      captured.id,
      captured.revision,
      intent,
      work,
    );
    const later = await store.captureIntent(context, captured.id, committed.revision, {
      ...newIntent(),
      stage: "shipping",
    });
    const before = await f.snapshot();
    expect(
      await store.runAtomicStage(context, captured.id, captured.revision, intent, work),
    ).toEqual(later);
    expect(later.revision).toBe(4);
    expect(await f.snapshot()).toEqual(before);
    expect(applied).toBe(1);
    expect(verified).toBe(2);
  });

  it("reloads current owner membership before canonical verification of a committed replay", async () => {
    const { captured, intent } = await capture();
    await store.runAtomicStage(context, captured.id, captured.revision, intent, work);
    await f.db.update(schema.member).set({ role: "traceability_qa" });
    applied = 0;
    verified = 0;
    await denied(
      () => store.runAtomicStage(context, captured.id, captured.revision, intent, work),
      "us_demo_target_invalid",
    );
  });

  it("never initializes an absent header or captures missing intent", async () => {
    const intent = newIntent();
    await denied(
      () => store.runAtomicStage(context, randomUUID(), 1, intent, work),
      "us_demo_seed_conflict",
    );
    const first = await store.initialize(context);
    await denied(
      () => store.runAtomicStage(context, first.id, first.revision, intent, work),
      "us_demo_intent_conflict",
    );
  });
  it.each(["stage", "operation", "input"])(
    "rejects a different %s before callbacks",
    async (kind) => {
      const { captured, intent } = await capture();
      const changed: UsDemoIntent = {
        ...intent,
        ...(kind === "stage" ? { stage: "shipping" as const } : {}),
        ...(kind === "operation" ? { operationKey: randomUUID() } : {}),
        ...(kind === "input"
          ? { input: { name: "Other" }, inputDigest: canonicalExportDigest({ name: "Other" }) }
          : {}),
      };
      await denied(
        () => store.runAtomicStage(context, captured.id, captured.revision, changed, work),
        "us_demo_intent_conflict",
      );
    },
  );
  it.each(["invalid", "other"])("rejects %s seed before callbacks", async (kind) => {
    const { captured, intent } = await capture();
    await denied(
      () =>
        store.runAtomicStage(
          context,
          kind === "invalid" ? "bad-id" : randomUUID(),
          captured.revision,
          intent,
          work,
        ),
      "us_demo_seed_conflict",
    );
  });
  it("rejects valid stale CAS on a pending stage", async () => {
    const { captured, intent } = await capture();
    await denied(
      () => store.runAtomicStage(context, captured.id, 1, intent, work),
      "us_demo_revision_conflict",
    );
  });
  it.each([NaN, Infinity, 0, -1, 1.5, 2147483648])(
    "rejects malformed revision %s on pending and completed stage",
    async (revision) => {
      const { captured, intent } = await capture();
      await denied(
        () => store.runAtomicStage(context, captured.id, revision, intent, work),
        "us_demo_revision_conflict",
      );
      await store.runAtomicStage(context, captured.id, captured.revision, intent, work);
      applied = 0;
      verified = 0;
      await denied(
        () => store.runAtomicStage(context, captured.id, revision, intent, work),
        "us_demo_revision_conflict",
      );
    },
  );
  it.each(["database", "tenant", "actor", "actual user", "QA", "revoked", "provenance", "profile"])(
    "reloads guarded target for %s before callbacks",
    async (kind) => {
      const { captured, intent } = await capture();
      const target = {
        ...context,
        ...(kind === "database" ? { expectedDatabaseName: "markiro_us_dev" } : {}),
        ...(kind === "tenant" ? { tenantId: randomUUID() } : {}),
        ...(kind === "actor" ? { actorUserId: randomUUID() } : {}),
      };
      if (kind === "QA") await f.db.update(schema.member).set({ role: "traceability_qa" });
      if (kind === "revoked") await f.db.delete(schema.member);
      if (kind === "provenance")
        await f.db.update(schema.organization).set({ metadata: "corrupt" });
      if (kind === "profile")
        await f.db.update(schema.orgProfiles).set({ timeZone: "America/Chicago" });
      const selected =
        kind === "actual user" ? new UsDemoJournalStore(await f.alternateRole()) : store;
      await denied(
        () => selected.runAtomicStage(target, captured.id, captured.revision, intent, work),
        "us_demo_target_invalid",
      );
    },
  );
  it.each(["header", "intent", "receipt", "stage revision"])(
    "refuses corrupt stored %s before callbacks without repair",
    async (kind) => {
      const { captured, intent } = await capture();
      if (kind === "header")
        await f.db.update(schema.traceabilityDemoSeeds).set({ definitionDigest: "a".repeat(64) });
      if (kind === "intent")
        await f.db.update(schema.traceabilityDemoSeedStages).set({ inputDigest: "a".repeat(64) });
      if (kind === "receipt")
        await f.db
          .update(schema.traceabilityDemoSeedStages)
          .set({ receipt: { recordIds: [], result: {}, resultDigest: "a".repeat(64) } });
      if (kind === "stage revision")
        await f.db.update(schema.traceabilityDemoSeedStages).set({ revision: 7 });
      await denied(
        () => store.runAtomicStage(context, captured.id, captured.revision, intent, work),
        "us_demo_journal_invalid",
      );
    },
  );
  it.each(["missing", "edited"])(
    "fails verification of %s canonical party on receipt replay without repair",
    async (kind) => {
      const { captured, intent } = await capture();
      await store.runAtomicStage(context, captured.id, captured.revision, intent, work);
      if (kind === "missing") await f.db.delete(schema.traceabilityParties);
      else
        await f.db.update(schema.traceabilityParties).set({ legalName: "Edited canonical party" });
      applied = 0;
      verified = 0;
      await denied(
        () => store.runAtomicStage(context, captured.id, captured.revision, intent, work),
        kind === "missing" ? "Not Found" : "synthetic_canonical_mismatch",
        true,
      );
      expect(applied).toBe(0);
      expect(verified).toBe(1);
    },
  );

  it.each(["apply", "audit", "invalid receipt", "verifier", "receipt write"])(
    "rolls back every persisted row when %s fails",
    async (kind) => {
      const { captured, intent } = await capture();
      if (kind === "audit" || kind === "receipt write") {
        await f.pool.query(
          `CREATE FUNCTION synthetic_atomic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic_atomic_failure'; END $$`,
        );
        await f.pool.query(
          `CREATE TRIGGER synthetic_atomic_failure BEFORE ${kind === "audit" ? "INSERT ON tenant_audit_events" : "UPDATE ON traceability_demo_seed_stages"} FOR EACH ROW EXECUTE FUNCTION synthetic_atomic_failure()`,
        );
      }
      const failing = {
        async apply(tx: Transaction, checked: UsDemoJournalContext, value: UsDemoIntent) {
          const receipt = await work.apply(tx, checked, value);
          if (kind === "apply") throw new Error("synthetic_apply_failure");
          return kind === "invalid receipt"
            ? { ...receipt, resultDigest: "a".repeat(64) }
            : receipt;
        },
        async verify(
          tx: Transaction,
          checked: UsDemoJournalContext,
          value: UsDemoIntent,
          receipt: UsDemoReceipt,
        ) {
          await work.verify(tx, checked, value, receipt);
          if (kind === "verifier") throw new Error("synthetic_verifier_failure");
        },
      };
      try {
        const before = await f.snapshot();
        const operation = store.runAtomicStage(
          context,
          captured.id,
          captured.revision,
          intent,
          failing,
        );
        if (kind === "audit" || kind === "receipt write")
          await expect(operation).rejects.toMatchObject({ cause: { code: "P0001" } });
        else
          await expect(operation).rejects.toThrow(
            kind === "apply"
              ? "synthetic_apply_failure"
              : kind === "verifier"
                ? "synthetic_verifier_failure"
                : "us_demo_receipt_digest_mismatch",
          );
        expect(await f.snapshot()).toEqual(before);
        expect(applied).toBe(1);
        expect(verified).toBe(kind === "verifier" || kind === "receipt write" ? 1 : 0);
        console.info(`Atomic rollback verified: ${kind}`);
      } finally {
        if (kind === "audit" || kind === "receipt write") {
          await f.pool.query(
            `DROP TRIGGER synthetic_atomic_failure ON ${kind === "audit" ? "tenant_audit_events" : "traceability_demo_seed_stages"}`,
          );
          await f.pool.query("DROP FUNCTION synthetic_atomic_failure()");
        }
      }
    },
  );
});
