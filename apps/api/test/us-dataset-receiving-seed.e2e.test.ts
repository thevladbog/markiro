import { randomUUID } from "node:crypto";
import { canonicalExportDigest } from "@markiro/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsDatasetJournalStore } from "../src/modules/traceability/demo/us-dataset-journal";
import {
  makeUsDatasetReceivingInput,
  makeUsDatasetReferenceIdentity,
} from "../src/modules/traceability/demo/us-dataset-receiving-contract";
import { usSixMonthDefinition } from "../src/modules/traceability/demo/us-six-month-definition";
import { UsReferenceDocumentStore } from "../src/modules/traceability/documents/us-reference-document-store";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { UsMasterDataStore } from "../src/modules/traceability/master-data/us-master-data-store";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsDatasetReceivingSeedStore } from "../src/modules/traceability/demo/us-dataset-receiving-seed";
import { UsDatasetReferenceSeedStore } from "../src/modules/traceability/demo/us-dataset-reference-seed";
import { createUsDatasetJournalFixture } from "./support/us-dataset-journal-fixture";

const base = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!base)("Dataset Receiving atomic application", () => {
  let f: Awaited<ReturnType<typeof createUsDatasetJournalFixture>>;
  let context: Awaited<ReturnType<typeof f.provision>>;
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated database");
    f = await createUsDatasetJournalFixture(base);
  }, 60000);
  beforeEach(async () => {
    context = await f.provision();
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });
  const journal = () => new UsDatasetJournalStore(f.db, usSixMonthDefinition);
  async function capture(index = 259) {
    const refs = await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const header = await journal().read(context);
    if (!header) throw new Error("Missing header");
    const shared = await journal().readStage(context, header.id, "references", "references");
    if (!shared) throw new Error("Missing shared stage");
    const input = makeUsDatasetReceivingInput(
      index,
      makeUsDatasetReferenceIdentity(header.id, shared),
    );
    const stage = await journal().captureIntent(context, header.id, {
      unitKey: input.chain.unitKey,
      stage: "receiving",
      operationKey: randomUUID(),
      input,
      inputDigest: canonicalExportDigest(input),
    });
    return { refs, header, input, stage };
  }
  it.each([0, 131, 259])(
    "atomically installs and verifies chain %i without replay writes",
    async (index) => {
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const seed = new UsDatasetReceivingSeedStore(f.db);
      const result = await seed.initialize(context, index);
      expect(result.documents).toHaveLength(2);
      expect(result.lots).toHaveLength(2);
      expect(result.finalized.record.content.kind).toBe("finalized");
      const counts = await f.pool.query(
        "SELECT (SELECT count(*)::int FROM reference_documents) AS docs, (SELECT count(*)::int FROM traceability_lots) AS lots, (SELECT count(*)::int FROM receiving_event_roots) AS roots, (SELECT sum(sequence)::int FROM receiving_counters) AS counter, (SELECT count(*)::int FROM receiving_operations) AS operations, (SELECT count(*)::int FROM traceability_demo_dataset_stages WHERE stage <> 'references') AS stages",
      );
      expect(counts.rows).toEqual([
        { docs: 2, lots: 2, roots: 1, counter: 1, operations: 2, stages: 1 },
      ]);
      if (result.finalized.record.content.kind !== "finalized") throw new Error("Not finalized");
      expect(result.finalized.record.content.snapshot.dateReceived).toBe(
        result.input.chain.receiving.eventDate,
      );
      expect(
        result.finalized.record.content.snapshot.items.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      ).toEqual(
        result.input.chain.receiving.lines.map(({ quantity, unitOfMeasure }) => ({
          quantity,
          unitOfMeasure,
        })),
      );
      const audits = (
        await f.pool.query(
          "SELECT organization_id, actor_user_id, action, target_type, target_id, outcome, request_id, before, after FROM tenant_audit_events WHERE request_id=$1",
          [result.created.operationKey],
        )
      ).rows;
      const expectedAudits = [
        ...result.documents.map(({ record }) => ({
          action: "traceability.reference_document.created",
          target_type: "traceability_reference_document",
          target_id: record.id,
          before: null,
          after: record,
        })),
        {
          action: "traceability.receiving.draft_created",
          target_type: "traceability_event",
          target_id: result.created.eventId,
          before: null,
          after: result.created.record,
        },
        ...result.lots.map((lot) => ({
          action: "traceability.lot.created",
          target_type: "traceability_lot",
          target_id: lot.id,
          before: null,
          after: { ...lot, eventId: result.created.eventId },
        })),
        {
          action: "traceability.receiving.finalized",
          target_type: "traceability_event",
          target_id: result.created.eventId,
          before: result.created.record,
          after: {
            rootId: result.created.eventId,
            revision: 1,
            reason: null,
            result: "finalized",
            effect: null,
            record: result.finalized.record,
            predecessor: null,
            lineLots: {
              before: [],
              after: result.finalized.record.content.snapshot.items.map(({ lineNo, lotId }) => ({
                lineNo,
                lotId,
              })),
            },
          },
        },
      ].map((audit) => ({
        ...audit,
        organization_id: context.tenantId,
        actor_user_id: context.actorUserId,
        outcome: "success",
        request_id: result.created.operationKey,
      }));
      expect(audits.map(canonicalExportDigest).sort()).toEqual(
        expectedAudits.map(canonicalExportDigest).sort(),
      );
      const operations = (
        await f.pool.query(
          "SELECT tenant_id, command, operation_key, event_id, input_digest, result FROM receiving_operations ORDER BY command",
        )
      ).rows;
      expect(operations).toEqual(
        [result.created, result.finalized].map((command) => ({
          tenant_id: context.tenantId,
          command: command.command,
          operation_key: command.operationKey,
          event_id: command.eventId,
          input_digest: command.inputDigest,
          result: command,
        })),
      );
      const before = await f.snapshot();
      expect(await seed.initialize(context, index)).toEqual(result);
      expect(await seed.verify(context, index)).toEqual(result);
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it.each(["missing dataset", "missing references", "pending references"])(
    "does not initialize %s",
    async (kind) => {
      if (kind !== "missing dataset") {
        const header = await journal().initialize(context);
        if (kind === "pending references")
          await journal().captureIntent(context, header.id, {
            unitKey: "references",
            stage: "references",
            operationKey: randomUUID(),
            input: {},
            inputDigest: canonicalExportDigest({}),
          });
      }
      const before = await f.snapshot();
      const seed = new UsDatasetReceivingSeedStore(f.db);
      await expect(seed.initialize(context, 0)).rejects.toThrow(
        "us_dataset_receiving_prerequisite_incomplete",
      );
      await expect(seed.verify(context, 0)).rejects.toThrow(
        "us_dataset_receiving_prerequisite_incomplete",
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it.each([-1, 260, 1.5, NaN, Infinity, "correction", "orphan"])(
    "rejects invalid index %s without writes",
    async (index) => {
      await new UsDatasetReferenceSeedStore(f.db).initialize(context);
      const before = await f.snapshot();
      // Deliberately exercise the untrusted runtime boundary.
      await expect(
        new UsDatasetReceivingSeedStore(f.db).initialize(context, index as number),
      ).rejects.toThrow("us_dataset_receiving_input_invalid");
      expect(await f.snapshot()).toEqual(before);
    },
  );
  it.each(["actor", "tenant", "database"])("rejects wrong %s before application", async (kind) => {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const target = {
      ...context,
      ...(kind === "actor"
        ? { actorUserId: randomUUID() }
        : kind === "tenant"
          ? { tenantId: randomUUID() }
          : { expectedDatabaseName: "markiro_us_dev" }),
    };
    const before = await f.snapshot();
    await expect(new UsDatasetReceivingSeedStore(f.db).initialize(target, 259)).rejects.toThrow(
      "us_dataset_target_invalid",
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it("verify never captures or applies absent or pending work", async () => {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const seed = new UsDatasetReceivingSeedStore(f.db);
    const before = await f.snapshot();
    await expect(seed.verify(context, 259)).rejects.toThrow(
      "us_dataset_receiving_prerequisite_incomplete",
    );
    expect(await f.snapshot()).toEqual(before);
    await capture();
    const pending = await f.snapshot();
    await expect(seed.verify(context, 259)).rejects.toThrow(
      "us_dataset_receiving_prerequisite_incomplete",
    );
    expect(await f.snapshot()).toEqual(pending);
  });
  it.each([
    [
      "second document",
      "reference_documents",
      "INSERT",
      "(SELECT count(*) FROM reference_documents)=1",
    ],
    [
      "draft audit",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.receiving.draft_created'",
    ],
    ["first lot audit", "tenant_audit_events", "INSERT", "NEW.action='traceability.lot.created'"],
    [
      "second lot audit",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.lot.created' AND (SELECT count(*) FROM traceability_lots)=2",
    ],
    [
      "finalization audit",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.receiving.finalized'",
    ],
    ["create operation", "receiving_operations", "INSERT", "NEW.command='receiving.create'"],
    ["finalize operation", "receiving_operations", "INSERT", "NEW.command='receiving.finalize'"],
    ["dataset receipt", "traceability_demo_dataset_stages", "UPDATE", "NEW.stage='receiving'"],
    ["40001", "receiving_operations", "INSERT", "NEW.command='receiving.finalize'"],
    ["40P01", "receiving_operations", "INSERT", "NEW.command='receiving.finalize'"],
    [
      "postwrite verifier",
      "tenant_audit_events",
      "INSERT",
      "NEW.action='traceability.receiving.finalized'",
    ],
  ])(
    "rolls back all persisted rows at %s and retries the stored key",
    async (name, table, action, condition) => {
      const c = await capture();
      const code = name === "40001" || name === "40P01" ? name : "P0001";
      const corruption = name === "postwrite verifier";
      await f.pool.query(
        `CREATE FUNCTION synthetic_receiving_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN ${corruption ? "UPDATE reference_documents SET notes='Trigger drift';" : `RAISE EXCEPTION 'synthetic_receiving_failure' USING ERRCODE='${code}';`} END IF; RETURN NEW; END $$`,
      );
      await f.pool.query(
        `CREATE TRIGGER synthetic_receiving_failure ${corruption ? "AFTER" : "BEFORE"} ${action} ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_receiving_failure()`,
      );
      const applySpy = vi.spyOn(UsReceivingStore.prototype, "createDraftCommandInTransaction");
      try {
        const before = await f.snapshot();
        const attempt = new UsDatasetReceivingSeedStore(f.db).initialize(context, 259);
        if (corruption) await expect(attempt).rejects.toThrow("us_dataset_receiving_mismatch");
        else await expect(attempt).rejects.toMatchObject({ cause: { code } });
        expect(await f.snapshot()).toEqual(before);
        if (name === "40001" || name === "40P01") expect(applySpy).toHaveBeenCalledTimes(1);
        expect(
          await journal().readStage(context, c.header.id, c.input.chain.unitKey, "receiving"),
        ).toEqual(c.stage);
      } finally {
        applySpy.mockRestore();
        await f.pool.query(`DROP TRIGGER synthetic_receiving_failure ON ${table}`);
        await f.pool.query("DROP FUNCTION synthetic_receiving_failure()");
      }
      const result = await new UsDatasetReceivingSeedStore(f.db).initialize(context, 259);
      expect(result.created.operationKey).toBe(c.stage.intent.operationKey);
      expect(result.finalized.operationKey).toBe(c.stage.intent.operationKey);
    },
  );
  it("concurrent captures reuse the winning complete intent and result", async () => {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    let arrivals = 0;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = UsDatasetJournalStore.prototype.captureIntent;
    const captureSpy = vi
      .spyOn(UsDatasetJournalStore.prototype, "captureIntent")
      .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
        arrivals++;
        if (arrivals === 2) release();
        await gate;
        return original.apply(this, args);
      });
    const results = await Promise.all([
      new UsDatasetReceivingSeedStore(f.db).initialize(context, 259),
      new UsDatasetReceivingSeedStore(f.db).initialize(context, 259),
    ]).finally(() => captureSpy.mockRestore());
    const [a, b] = results;
    expect(arrivals).toBe(2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(
      (await f.pool.query("SELECT count(*)::int AS n FROM receiving_event_roots")).rows,
    ).toEqual([{ n: 1 }]);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM traceability_lots")).rows).toEqual([
      { n: 2 },
    ]);
    expect((await f.pool.query("SELECT count(*)::int AS n FROM reference_documents")).rows).toEqual(
      [{ n: 2 }],
    );
    expect(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM traceability_demo_dataset_stages WHERE stage='receiving'",
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
  it("rejects a captured altered descriptor without recapture", async () => {
    const c = await capture();
    const input = {
      ...c.input,
      chain: {
        ...c.input.chain,
        receiving: { ...c.input.chain.receiving, eventDate: "2026-01-01" },
      },
    };
    await f.pool.query(
      "UPDATE traceability_demo_dataset_stages SET input=$1, input_digest=$2 WHERE stage='receiving'",
      [input, canonicalExportDigest(input)],
    );
    const before = await f.snapshot();
    await expect(new UsDatasetReceivingSeedStore(f.db).initialize(context, 259)).rejects.toThrow(
      "us_dataset_receiving_dependency_conflict",
    );
    expect(await f.snapshot()).toEqual(before);
  });
  it("retains chain context and original cause for shared catalogue drift", async () => {
    const c = await capture();
    const party = c.refs.bindings.parties[0];
    if (!party) throw new Error("Missing party");
    await new UsMasterDataStore(f.db).updateParty(
      context.tenantId,
      context.actorUserId,
      party.id,
      { name: "Changed synthetic party" },
      "drift",
    );
    const before = await f.snapshot();
    await expect(
      new UsDatasetReceivingSeedStore(f.db).initialize(context, 259),
    ).rejects.toMatchObject({
      message: "us_dataset_receiving_mismatch",
      unitKey: c.input.chain.unitKey,
      stage: "receiving",
      cause: { message: "us_dataset_reference_mismatch" },
    });
    expect(await f.snapshot()).toEqual(before);
  });
  it("different concurrent units remain independent", async () => {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const [a, b] = await Promise.all([
      new UsDatasetReceivingSeedStore(f.db).initialize(context, 0),
      new UsDatasetReceivingSeedStore(f.db).initialize(context, 131),
    ]);
    expect(a.created.operationKey).not.toBe(b.created.operationKey);
    expect(a.created.eventId).not.toBe(b.created.eventId);
    const before = await f.snapshot();
    expect(await new UsDatasetReceivingSeedStore(f.db).verify(context, 0)).toEqual(a);
    expect(await new UsDatasetReceivingSeedStore(f.db).verify(context, 131)).toEqual(b);
    expect(await f.snapshot()).toEqual(before);
  });
  it("recovers lost commit acknowledgement in a fresh instance without writes", async () => {
    await new UsDatasetReferenceSeedStore(f.db).initialize(context);
    const original = UsDatasetJournalStore.prototype.runAtomicStage;
    const transport = vi
      .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
      .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
        await original.apply(this, args);
        throw new Error("lost committed acknowledgement");
      });
    try {
      await expect(new UsDatasetReceivingSeedStore(f.db).initialize(context, 259)).rejects.toThrow(
        "lost committed acknowledgement",
      );
    } finally {
      transport.mockRestore();
    }
    const before = await f.snapshot();
    const recovered = await new UsDatasetReceivingSeedStore(f.db).initialize(context, 259);
    expect(await new UsDatasetReceivingSeedStore(f.db).verify(context, 259)).toEqual(recovered);
    expect(await f.snapshot()).toEqual(before);
  });
  it("rejects dependency changed between capture and execution before business writes", async () => {
    const c = await capture();
    const original = UsDatasetJournalStore.prototype.runAtomicStage;
    let changed: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const transport = vi
      .spyOn(UsDatasetJournalStore.prototype, "runAtomicStage")
      .mockImplementation(async function (this: UsDatasetJournalStore, ...args) {
        await f.pool.query(
          "UPDATE traceability_demo_dataset_stages SET operation_key=$1 WHERE stage='references'",
          [randomUUID()],
        );
        changed = await f.snapshot();
        return original.apply(this, args);
      });
    try {
      await expect(new UsDatasetReceivingSeedStore(f.db).initialize(context, 259)).rejects.toThrow(
        "us_dataset_receiving_dependency_conflict",
      );
      expect(await f.snapshot()).toEqual(changed);
      expect(
        (await journal().readStage(context, c.header.id, c.input.chain.unitKey, "receiving"))
          ?.intent,
      ).toEqual(c.stage.intent);
    } finally {
      transport.mockRestore();
    }
  });
  it.each(["document", "lot", "operation"])(
    "rejects precreated %s without adoption",
    async (kind) => {
      const c = await capture();
      const bound = (entries: readonly { key: string; id: string }[], key: string) => {
        const match = entries.find((e) => e.key === key);
        if (!match) throw new Error("Missing binding");
        return match.id;
      };
      if (kind === "document") {
        const d = c.input.chain.documents.find(
          (d) => d.input.number === c.input.chain.receiving.references[0],
        );
        if (!d) throw new Error("Missing document");
        await new UsReferenceDocumentStore(f.db).createDocument(
          context.tenantId,
          context.actorUserId,
          { ...d.input, partyId: bound(c.refs.bindings.parties, d.partyKey) },
          "precreated",
        );
      } else if (kind === "lot") {
        const line = c.input.chain.receiving.lines[0];
        if (!line) throw new Error("Missing line");
        await new UsLotStore(f.db).createLot(
          context.tenantId,
          context.actorUserId,
          {
            productId: bound(c.refs.bindings.products, line.productKey),
            tlc: line.tlc,
            assignmentBasis: "imported",
            source: {
              kind: "location",
              locationId: bound(
                c.refs.bindings.locations,
                c.input.chain.receiving.previousSourceLocationKey,
              ),
            },
          },
          "precreated",
        );
      } else
        await new UsReceivingStore(f.db).createDraftCommand(
          context.tenantId,
          context.actorUserId,
          {
            operationKey: c.stage.intent.operationKey,
            draft: {
              dateReceived: null,
              locationId: null,
              previousSourceLocationId: null,
              receivedAtNote: null,
              notes: null,
              documentIds: [],
              items: [],
            },
          },
          "precreated",
        );
      const before = await f.snapshot();
      await expect(new UsDatasetReceivingSeedStore(f.db).initialize(context, 259)).rejects.toThrow(
        "us_dataset_receiving_conflict",
      );
      expect(await f.snapshot()).toEqual(before);
    },
  );
});
