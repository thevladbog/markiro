import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { transformationGenealogyResultSchema } from "@markiro/platform-contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedFinalizableTransformation } from "./support/us-transformation-finalization-fixture";
import {
  seedTwoByTwoGenealogy,
  seedZeroFtlGenealogy,
  seedVoidedAmendmentDraftGenealogy,
} from "./support/us-transformation-genealogy-fixture";
import {
  seedTransformationRevision,
  finalizationCommand,
  revisionState,
  downstreamDraft,
} from "./support/us-transformation-revision-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const query = (startLotId: string, direction: "upstream" | "downstream" = "upstream") => ({
  mode: "current" as const,
  startLotId,
  direction,
  maxDepth: 20,
  maxNodes: 500,
});
describe.skipIf(!url)("internal Transformation genealogy", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
  }, 60000);
  afterAll(async () => {
    await f?.close();
  });

  it.each([
    { inputs: 40, outputs: 50, edges: 2000 },
    { inputs: 69, outputs: 29, edges: 2001 },
    { inputs: 46, outputs: 46, edges: 2116 },
  ])(
    "distinguishes intact persisted $edges-edge evidence from a storage inconsistency",
    async ({ inputs, outputs, edges }) => {
      const c = await seedFinalizableTransformation(f);
      const firstItem = c.draft.items[0];
      if (!firstItem) throw new Error("Missing Receiving input fixture");
      const receivingDraft = await c.receiving.createDraft(
        c.tenant,
        c.actor,
        {
          operationKey: randomUUID(),
          draft: {
            ...c.draft,
            items: Array.from({ length: inputs }, (_, index) => ({
              ...firstItem,
              lotId: null,
              lotLinkMode: "create_on_finalize" as const,
              tlc: `LINK-CAP-INPUT-${index}`,
              quantity: "1",
              unitOfMeasure: "lb" as const,
            })),
          },
        },
        "genealogy-link-cap-receiving",
      );
      const receivingReady = await c.receiving.checkReadiness(
        c.tenant,
        c.actor,
        receivingDraft.id,
        { expectedDraftVersion: 1 },
      );
      const receiving = await c.receiving.finalize(
        c.tenant,
        c.actor,
        receivingDraft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: receivingReady.inputDigest,
        },
        "genealogy-link-cap-receiving-finalize",
      );
      const draft = await c.store.saveDraft(
        c.tenant,
        c.actor,
        c.saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: {
            ...c.saved.draft,
            inputs: receiving.snapshot.items.map((item) => ({
              kind: "ftl_lot" as const,
              lotId: item.lotId,
              quantity: "1",
              unitOfMeasure: "lb" as const,
            })),
            outputs: Array.from({ length: outputs }, (_, index) => ({
              productId: c.product,
              tlc: `LINK-CAP-OUTPUT-${index}`,
              quantity: "1",
              unitOfMeasure: "lb" as const,
            })),
          },
        },
        "genealogy-link-cap-save",
      );
      const ready = await c.store.checkReadiness(c.tenant, c.actor, draft.id, {
        expectedDraftVersion: draft.draftVersion,
      });
      const finalized = await c.store.finalize(
        c.tenant,
        c.actor,
        draft.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: draft.draftVersion,
          expectedInputDigest: ready.inputDigest,
        },
        "genealogy-link-cap-finalize",
      );
      expect(
        (
          await f.pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM lot_genealogy_edges WHERE tenant_id=$1 AND event_id=$2",
            [c.tenant, finalized.id],
          )
        ).rows[0]?.count,
      ).toBe(edges);
      const request = query(finalized.snapshot.outputs[0]!.lotId);
      for (const mode of ["current", "pinned"] as const) {
        const result = await c.store.getGenealogy(c.tenant, c.actor, {
          ...request,
          mode,
          ...(mode === "pinned" ? { pinnedRevisionIds: [finalized.id] } : {}),
        });
        expect(result.links).toHaveLength(2000);
        expect(result.complete).toBe(edges === 2000);
        expect(result.diagnostics.some((item) => item.code === "limit")).toBe(edges > 2000);
        expect(result.diagnostics.some((item) => item.code === "inconsistent_evidence")).toBe(
          false,
        );
      }
    },
    60000,
  );

  it("still diagnoses genuinely missing persisted edges below the link cap", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(sql`DELETE FROM lot_genealogy_edges WHERE tenant_id=${c.tenant} AND event_id=${c.revision.id}
        AND (input_lot_id,output_lot_id)=(SELECT input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE tenant_id=${c.tenant} AND event_id=${c.revision.id} ORDER BY input_lot_id,output_lot_id LIMIT 1)`);
    });
    const result = await c.store.getGenealogy(
      c.tenant,
      c.actor,
      query(c.revision.snapshot.outputs[0]!.lotId),
    );
    expect(result.links).toHaveLength(3);
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual([{ code: "inconsistent_evidence", eventId: c.revision.id }]);
  });

  it.each(["upstream", "downstream"] as const)(
    "selects only current 2-to-2 evidence %s with valid Receiving origins",
    async (direction) => {
      const c = await seedTwoByTwoGenealogy(f);
      const start =
        direction === "upstream"
          ? c.revision.snapshot.outputs[0]!.lotId
          : c.origin.snapshot.items[0]!.lotId;
      const before = await revisionState(f, c.tenant);
      const result = await c.store.getGenealogy(c.tenant, c.actor, query(start, direction));
      expect(result.selectedRevisionIds).toEqual([c.revision.id]);
      expect(result.events).toMatchObject([{ status: "finalized", snapshot: c.revision.snapshot }]);
      expect(result.lots).toHaveLength(4);
      expect(result.lots.every((lot) => lot.currentOrigin)).toBe(true);
      expect(result.links).toHaveLength(4);
      expect(result).toMatchObject({
        complete: true,
        diagnostics: [],
        balance: { state: "unknown" },
      });
      expect(transformationGenealogyResultSchema.safeParse(result).success).toBe(true);
      expect(await revisionState(f, c.tenant)).toEqual(before);
    },
  );
  it("pins exact amended evidence and saved descriptions after mutable master data changes", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    await f.db
      .update(schema.products)
      .set({ name: "Changed live product" })
      .where(eq(schema.products.id, c.product));
    await f.db
      .update(schema.traceabilityLocations)
      .set({ businessName: "Changed live location" })
      .where(eq(schema.traceabilityLocations.id, c.processor));
    const result = await c.store.getGenealogy(c.tenant, c.actor, {
      ...query(c.original.snapshot.outputs[0]!.lotId),
      mode: "pinned",
      pinnedRevisionIds: [c.original.id],
    });
    expect(result.selectedRevisionIds).toEqual([c.original.id]);
    expect(result.events).toMatchObject([{ status: "amended", snapshot: c.original.snapshot }]);
    expect(result.links).toHaveLength(4);
    expect(result.complete).toBe(true);
  });
  it("keeps a void origin gap and its exact zero-edge historical snapshot", async () => {
    const c = await seedZeroFtlGenealogy(f);
    const start = c.revision.snapshot.outputs[0]!.lotId;
    expect(await c.store.getGenealogy(c.tenant, c.actor, query(start))).toMatchObject({
      events: [],
      links: [],
      lots: [{ id: start, currentOrigin: false }],
      complete: false,
      diagnostics: [{ code: "origin_gap", lotId: start }],
    });
    const pinned = await c.store.getGenealogy(c.tenant, c.actor, {
      ...query(start),
      mode: "pinned",
      pinnedRevisionIds: [c.revision.id],
    });
    expect(pinned.events).toMatchObject([
      { id: c.revision.id, status: "void", snapshot: c.revision.snapshot },
    ]);
    expect(pinned.links).toEqual([]);
  });
  it("finds a current zero-edge output independently of genealogy edges", async () => {
    const c = await seedZeroFtlGenealogy(f);
    // Simulate the prior committed finalized state in this disposable database.
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET status='finalized',voided_at=NULL,voided_by=NULL,void_reason=NULL WHERE tenant_id=${c.tenant} AND id=${c.revision.id}`,
      );
      await tx.execute(
        sql`UPDATE transformation_event_roots SET current_event_id=${c.revision.id},lifecycle_version=4 WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
      );
    });
    const result = await c.store.getGenealogy(
      c.tenant,
      c.actor,
      query(c.revision.snapshot.outputs[0]!.lotId),
    );
    expect(result).toMatchObject({
      complete: true,
      links: [],
      events: [{ id: c.revision.id, snapshot: c.revision.snapshot }],
    });
  });
  it("pins a snapshotless void draft without borrowing its predecessor snapshot or edges", async () => {
    const c = await seedVoidedAmendmentDraftGenealogy(f);
    const result = await c.store.getGenealogy(c.tenant, c.actor, {
      ...query(c.original.snapshot.outputs[0]!.lotId),
      mode: "pinned",
      pinnedRevisionIds: [c.voidedDraft.id],
    });
    expect(result).toMatchObject({
      selectedRevisionIds: [c.voidedDraft.id],
      events: [{ id: c.voidedDraft.id, status: "void", snapshot: null }],
      links: [],
      complete: true,
      balance: { state: "unknown", values: [] },
    });
  });
  it("rejects a zero-edge current snapshot that disagrees with its persisted output binding", async () => {
    const c = await seedZeroFtlGenealogy(f);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(sql`UPDATE traceability_events SET status='finalized',voided_at=NULL,voided_by=NULL,void_reason=NULL,
        finalization_snapshot=jsonb_set(finalization_snapshot,'{outputs,0,lotId}',to_jsonb(${c.origin.snapshot.items[0]!.lotId}::text))
        WHERE tenant_id=${c.tenant} AND id=${c.revision.id}`);
      await tx.execute(
        sql`UPDATE transformation_event_roots SET current_event_id=${c.revision.id},lifecycle_version=4 WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
      );
    });
    await expect(
      c.store.getGenealogy(c.tenant, c.actor, query(c.revision.snapshot.outputs[0]!.lotId)),
    ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
  });
  it("excludes pending drafts and rejects an explicit pinned draft", async () => {
    const c = await seedTransformationRevision(f);
    const q = query(c.original.snapshot.outputs[0]!.lotId);
    expect((await c.store.getGenealogy(c.tenant, c.actor, q)).selectedRevisionIds).toEqual([
      c.original.id,
    ]);
    await expect(
      c.store.getGenealogy(c.tenant, c.actor, {
        ...q,
        mode: "pinned",
        pinnedRevisionIds: [c.amendment.id],
      }),
    ).rejects.toMatchObject({ response: { code: "transformation_not_found" } });
  });
  it("authorizes before lookup and does not reveal foreign lots, revisions, or Receiving event IDs", async () => {
    const c = await seedTwoByTwoGenealogy(f),
      foreign = await seedTwoByTwoGenealogy(f);
    const q = query(c.original.snapshot.outputs[0]!.lotId);
    await expect(
      c.store.getGenealogy(c.tenant, foreign.actor, query(randomUUID())),
    ).rejects.toMatchObject({ response: { code: "insufficient_permission" } });
    await expect(
      c.store.getGenealogy(c.tenant, c.actor, query(foreign.original.snapshot.outputs[0]!.lotId)),
    ).rejects.toMatchObject({ response: { code: "transformation_reference_not_found" } });
    for (const id of [foreign.original.id, randomUUID(), c.origin.id])
      await expect(
        c.store.getGenealogy(c.tenant, c.actor, { ...q, mode: "pinned", pinnedRevisionIds: [id] }),
      ).rejects.toMatchObject({ response: { code: "transformation_not_found" } });
  });
  it("does not invent an origin from source-only imported lot metadata", async () => {
    const c = await seedFinalizableTransformation(f);
    const id = randomUUID();
    await f.db.insert(schema.traceabilityLots).values({
      id,
      tenantId: c.tenant,
      productId: c.product,
      tlc: "SOURCE-ONLY",
      assignmentBasis: "imported",
      sourceLocationId: c.location,
      createdBy: c.actor,
      updatedBy: c.actor,
    });
    expect(await c.store.getGenealogy(c.tenant, c.actor, query(id))).toMatchObject({
      lots: [{ id, currentOrigin: false }],
      complete: false,
      diagnostics: [{ code: "origin_gap", lotId: id }],
    });
  });
  it.each(["pointer", "supersession", "snapshot", "missing-edge"])(
    "fails closed on corrupt %s evidence",
    async (corruption) => {
      const c = await seedTwoByTwoGenealogy(f);
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        if (corruption === "pointer")
          await tx.execute(
            sql`UPDATE transformation_event_roots SET current_event_id=${c.original.id} WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
          );
        if (corruption === "supersession")
          await tx.execute(
            sql`UPDATE traceability_events SET superseded_by_event_id=${randomUUID()} WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
          );
        if (corruption === "snapshot")
          await tx.execute(
            sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{eventId}',to_jsonb(${randomUUID()}::text)) WHERE tenant_id=${c.tenant} AND id=${c.revision.id}`,
          );
        if (corruption === "missing-edge")
          await tx.execute(
            sql`DELETE FROM lot_genealogy_edges WHERE tenant_id=${c.tenant} AND event_id=${c.revision.id}`,
          );
      });
      const result = await c.store
        .getGenealogy(c.tenant, c.actor, query(c.revision.snapshot.outputs[0]!.lotId))
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      if ("value" in result)
        expect(result.value).toMatchObject({
          complete: false,
          diagnostics: expect.arrayContaining([
            { code: "inconsistent_evidence", eventId: c.revision.id },
          ]),
        });
      else expect(result.error).toMatchObject({ response: { code: "us_database_unavailable" } });
    },
  );
  it.each(["input", "output", "edge"] as const)(
    "rejects an orphan %s on a reached lot in current and pinned reads",
    async (kind) => {
      const c = await seedTwoByTwoGenealogy(f);
      const inputLotId = c.origin.snapshot.items[0]!.lotId;
      const outputLotId = c.revision.snapshot.outputs[0]!.lotId;
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        const eventId = randomUUID();
        if (kind === "input")
          await tx.insert(schema.transformationEventInputs).values({
            tenantId: c.tenant,
            eventId,
            lineNo: 1,
            kind: "ftl_lot",
            lotId: inputLotId,
            quantity: "1",
            unitOfMeasure: "lb",
          });
        if (kind === "output")
          await tx.insert(schema.transformationEventOutputs).values({
            tenantId: c.tenant,
            eventId,
            lineNo: 1,
            lotId: outputLotId,
            quantity: "1",
            unitOfMeasure: "case",
          });
        if (kind === "edge")
          await tx
            .insert(schema.lotGenealogyEdges)
            .values({ tenantId: c.tenant, eventId, inputLotId, outputLotId });
      });
      for (const direction of ["upstream", "downstream"] as const) {
        const request = query(direction === "upstream" ? outputLotId : inputLotId, direction);
        await expect(c.store.getGenealogy(c.tenant, c.actor, request)).rejects.toMatchObject({
          response: { code: "us_database_unavailable" },
        });
        await expect(
          c.store.getGenealogy(c.tenant, c.actor, {
            ...request,
            mode: "pinned",
            pinnedRevisionIds: [c.revision.id],
          }),
        ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
      }
    },
  );
  it.each(["input", "output", "edge"] as const)(
    "rejects a %s whose parent is a Receiving event",
    async (kind) => {
      const c = await seedTwoByTwoGenealogy(f);
      const inputLotId = c.origin.snapshot.items[0]!.lotId;
      const outputLotId = c.revision.snapshot.outputs[0]!.lotId;
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        if (kind === "input")
          await tx.insert(schema.transformationEventInputs).values({
            tenantId: c.tenant,
            eventId: c.origin.id,
            lineNo: 1,
            kind: "ftl_lot",
            lotId: inputLotId,
            quantity: "1",
            unitOfMeasure: "lb",
          });
        if (kind === "output")
          await tx.insert(schema.transformationEventOutputs).values({
            tenantId: c.tenant,
            eventId: c.origin.id,
            lineNo: 1,
            lotId: outputLotId,
            quantity: "1",
            unitOfMeasure: "case",
          });
        if (kind === "edge")
          await tx
            .insert(schema.lotGenealogyEdges)
            .values({ tenantId: c.tenant, eventId: c.origin.id, inputLotId, outputLotId });
      });
      await expect(
        c.store.getGenealogy(c.tenant, c.actor, query(outputLotId)),
      ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
    },
  );
  it("rejects an unrelated snapshot predecessor in current and pinned reads", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{previousRevisionId}',to_jsonb(${randomUUID()}::text)) WHERE tenant_id=${c.tenant} AND id=${c.revision.id}`,
      );
    });
    const request = query(c.revision.snapshot.outputs[0]!.lotId);
    await expect(c.store.getGenealogy(c.tenant, c.actor, request)).rejects.toMatchObject({
      response: { code: "us_database_unavailable" },
    });
    await expect(
      c.store.getGenealogy(c.tenant, c.actor, {
        ...request,
        mode: "pinned",
        pinnedRevisionIds: [c.revision.id],
      }),
    ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
  });
  it.each(["missing", "foreign", "wrong-root", "self"] as const)(
    "rejects a snapshotless void draft with a %s predecessor relation",
    async (kind) => {
      const c = await seedVoidedAmendmentDraftGenealogy(f);
      const foreign = kind === "foreign" ? await seedTwoByTwoGenealogy(f) : undefined;
      const id =
        kind === "missing"
          ? randomUUID()
          : kind === "foreign"
            ? foreign?.original.id
            : kind === "wrong-root"
              ? c.origin.id
              : c.voidedDraft.id;
      if (!id) throw new Error("Missing predecessor fixture");
      await f.db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
        await tx.execute(
          sql`UPDATE traceability_events SET previous_revision_id=${id} WHERE tenant_id=${c.tenant} AND id=${c.voidedDraft.id}`,
        );
      });
      await expect(
        c.store.getGenealogy(c.tenant, c.actor, {
          ...query(c.original.snapshot.outputs[0]!.lotId),
          mode: "pinned",
          pinnedRevisionIds: [c.voidedDraft.id],
        }),
      ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
    },
  );
  it.each([
    { maxDepth: 0, maxNodes: 500 },
    { maxDepth: 20, maxNodes: 1 },
  ])("diagnoses bounded traversal %j", async (limits) => {
    const c = await seedTwoByTwoGenealogy(f);
    const result = await c.store.getGenealogy(c.tenant, c.actor, {
      ...query(c.revision.snapshot.outputs[0]!.lotId),
      ...limits,
    });
    expect(result.complete).toBe(false);
    expect(result.diagnostics.some((d) => d.code === "limit")).toBe(true);
    expect(result.lots.length + result.events.length).toBeLessThanOrEqual(limits.maxNodes);
  });
  it("does not report truncation when the complete graph exactly fills the node cap", async () => {
    const c = await seedTwoByTwoGenealogy(f);
    const result = await c.store.getGenealogy(c.tenant, c.actor, {
      ...query(c.revision.snapshot.outputs[0]!.lotId),
      maxNodes: 5,
    });
    expect(result).toMatchObject({ complete: true, diagnostics: [] });
    expect(result.events.length + result.lots.length).toBe(5);
  });
  it("fails closed when persisted snapshots reference a foreign lot", async () => {
    const c = await seedTwoByTwoGenealogy(f),
      foreign = await seedTwoByTwoGenealogy(f);
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{inputs,0,lotId}',to_jsonb(${foreign.revision.snapshot.outputs[0]!.lotId}::text)) WHERE tenant_id=${c.tenant} AND id=${c.revision.id}`,
      );
    });
    await expect(
      c.store.getGenealogy(c.tenant, c.actor, query(c.revision.snapshot.outputs[0]!.lotId)),
    ).rejects.toMatchObject({ response: { code: "us_database_unavailable" } });
  });
  it("diagnoses a persisted cycle and terminates in either direction", async () => {
    const c = await seedTransformationRevision(f);
    const childDraft = await downstreamDraft(c);
    const child = await c.store.finalize(
      c.tenant,
      c.actor,
      childDraft.id,
      await finalizationCommand(c, childDraft),
      "child",
    );
    const descendant = child.snapshot.outputs[0]!.lotId;
    const firstInput = c.original.snapshot.inputs[0]!;
    if (firstInput.kind !== "ftl_lot") throw new Error("Expected FTL input");
    await f.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL session_replication_role='replica'`);
      await tx.execute(
        sql`UPDATE traceability_events SET finalization_snapshot=jsonb_set(finalization_snapshot,'{inputs,0,lotId}',to_jsonb(${descendant}::text)) WHERE tenant_id=${c.tenant} AND id=${c.original.id}`,
      );
      await tx.execute(
        sql`UPDATE transformation_event_inputs SET lot_id=${descendant} WHERE tenant_id=${c.tenant} AND event_id=${c.original.id} AND line_no=1`,
      );
      await tx.execute(
        sql`UPDATE lot_genealogy_edges SET input_lot_id=${descendant} WHERE tenant_id=${c.tenant} AND event_id=${c.original.id} AND input_lot_id=${firstInput.lotId}`,
      );
    });
    for (const direction of ["upstream", "downstream"] as const) {
      const result = await c.store.getGenealogy(c.tenant, c.actor, query(descendant, direction));
      expect(result.complete).toBe(false);
      expect(result.diagnostics.some((d) => d.code === "cycle")).toBe(true);
      expect(result.events).toHaveLength(2);
    }
  });
  it.each(["amend", "void"])(
    "keeps one snapshot while %s commits during a read",
    async (operation) => {
      const c = await seedTransformationRevision(f);
      if (operation === "void")
        await c.store.void(
          c.tenant,
          c.actor,
          c.amendment.id,
          {
            operationKey: randomUUID(),
            expectedLifecycleVersion: 3,
            expectedDraftVersion: 1,
            reason: "Cancel",
          },
          "cancel",
        );
      const command = operation === "amend" ? await finalizationCommand(c, c.amendment) : undefined;
      let reached!: () => void, resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const transaction = f.db.transaction.bind(f.db);
      let executionCount = 0;
      const spy = vi.spyOn(f.db, "transaction").mockImplementation((run, config) =>
        transaction(async (tx) => {
          const execute = tx.execute.bind(tx);
          vi.spyOn(tx, "execute").mockImplementation((...args: Parameters<typeof execute>) => {
            const raw = execute(...args);
            const perform = raw.execute.bind(raw);
            vi.spyOn(raw, "execute").mockImplementation(async () => {
              const result = await perform();
              if (++executionCount === 3) {
                reached();
                await resumed;
              }
              return result;
            });
            return raw;
          });
          return run(tx);
        }, config),
      );
      let pending: ReturnType<typeof c.store.getGenealogy> | undefined;
      try {
        pending = c.store.getGenealogy(
          c.tenant,
          c.actor,
          query(c.original.snapshot.outputs[0]!.lotId),
        );
        await Promise.race([
          entered,
          pending.then(() => {
            throw new Error("Read did not reach barrier");
          }),
        ]);
        if (command)
          await c.store.finalize(c.tenant, c.actor, c.amendment.id, command, "race-amend");
        else
          await c.store.void(
            c.tenant,
            c.actor,
            c.original.id,
            { operationKey: randomUUID(), expectedLifecycleVersion: 4, reason: "Void" },
            "race-void",
          );
        resume();
        expect(await pending).toMatchObject({
          complete: true,
          selectedRevisionIds: [c.original.id],
          events: [{ id: c.original.id, status: "finalized", snapshot: c.original.snapshot }],
        });
        const next = await c.store.getGenealogy(
          c.tenant,
          c.actor,
          query(c.original.snapshot.outputs[0]!.lotId),
        );
        expect(next.selectedRevisionIds).toEqual(command ? [c.amendment.id] : []);
      } finally {
        resume();
        await pending?.catch(() => undefined);
        spy.mockRestore();
      }
    },
    15000,
  );
});
