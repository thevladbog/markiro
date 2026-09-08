import { createHash, randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import {
  finalizeReceivingSchema,
  finalizeReceivingRevisionSchema,
  receivingFinalizeResultSchema,
  receivingFinalizedRecordSchema,
  type ReceivingCommandResult,
} from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving, seedExemptReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function versioned(result: ReceivingCommandResult) {
  if (!("receiptVersion" in result)) throw new Error("Expected a versioned acknowledgement");
  return result;
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );

describe.skipIf(!url)(
  "Receiving finalization command compatibility bridge",
  { timeout: 15000 },
  () => {
    let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
    let store: UsReceivingStore;
    let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
    beforeAll(async () => {
      if (!url) throw new Error("Missing synthetic database");
      f = await createUsProfileTestDatabase(url);
      store = new UsReceivingStore(f.db);
    }, 60_000);
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      c = await seedCompleteReceiving(f.db);
    });
    const create = () =>
      store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft: c.draft },
        "create",
      );
    async function commands(id: string, draftVersion = 1) {
      const ready = await store.checkRevisionReadiness(c.tenant, c.actor, id, {
        expectedDraftVersion: draftVersion,
      });
      const original = {
        operationKey: randomUUID(),
        expectedDraftVersion: draftVersion,
        expectedInputDigest: ready.inputDigest,
      };
      const revision = {
        ...original,
        commandVersion: 2 as const,
        expectedLifecycleVersion: ready.expectedLifecycleVersion,
        previousRevisionId: ready.previousRevisionId,
        reviewedExemptLines: ready.exemptReviewRequiredLines,
      };
      return { original, revision, ready };
    }
    const finalize = (id: string, input: unknown, requestId = "finalize") =>
      store.finalizeCommand(c.tenant, c.actor, id, input, requestId);
    const cancel = (id: string, lifecycleVersion: number, draftVersion: number | null) =>
      store.void(
        c.tenant,
        c.actor,
        id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: lifecycleVersion,
          expectedDraftVersion: draftVersion,
          reason: "Entered in error",
        },
        "void",
      );
    const amend = (id: string) =>
      store.amend(
        c.tenant,
        c.actor,
        id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Correct receipt",
        },
        "amend",
      );
    async function state() {
      return (
        await f.pool.query(
          `SELECT
      (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM traceability_events e WHERE tenant_id=$1) AS events,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM receiving_event_roots r WHERE tenant_id=$1) AS roots,
      (SELECT jsonb_agg(to_jsonb(i) ORDER BY event_id,line_no) FROM receiving_event_items i WHERE tenant_id=$1) AS items,
      (SELECT jsonb_agg(to_jsonb(d) ORDER BY event_id,position) FROM receiving_event_documents d WHERE tenant_id=$1) AS documents,
      (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM traceability_lots l WHERE tenant_id=$1) AS lots,
      (SELECT jsonb_agg(to_jsonb(o) ORDER BY operation_key) FROM receiving_operations o WHERE tenant_id=$1) AS receipts,
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM tenant_audit_events a WHERE organization_id=$1) AS audit`,
          [c.tenant],
        )
      ).rows[0];
    }
    async function oldFinalization() {
      const saved = await create();
      const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      const input = {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: ready.inputDigest,
      };
      const result = await store.finalize(c.tenant, c.actor, saved.id, input, "old-finalize");
      return { input, result };
    }

    async function compete<A, B>(
      rootId: string,
      first: () => Promise<A>,
      second: () => Promise<B>,
    ) {
      const gate = await f.pool.connect();
      let a: ReturnType<typeof outcome<A>> | undefined;
      let b: ReturnType<typeof outcome<B>> | undefined;
      try {
        await gate.query("BEGIN");
        const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing synthetic barrier");
        await gate.query(
          "SELECT id FROM receiving_event_roots WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
          [c.tenant, rootId],
        );
        async function waitFor(count: number) {
          await expect
            .poll(
              async () =>
                (
                  await f.pool.query<{ count: number }>(
                    "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS count FROM blocked",
                    [pid],
                  )
                ).rows[0]?.count,
              { timeout: 5000 },
            )
            .toBeGreaterThanOrEqual(count);
        }
        a = outcome(first());
        await waitFor(1);
        b = outcome(second());
        await waitFor(2);
        await gate.query("COMMIT");
        return await Promise.all([a, b]);
      } finally {
        await gate.query("ROLLBACK");
        gate.release();
        await Promise.all([a, b]);
      }
    }

    it.each([true, false])(
      "commits one original finalization under concurrency (same key=%s)",
      async (sameKey) => {
        const saved = await create(),
          { original } = await commands(saved.id);
        const [a, b] = await compete(
          saved.id,
          () => finalize(saved.id, original, "first"),
          () =>
            finalize(
              saved.id,
              { ...original, operationKey: sameKey ? original.operationKey : randomUUID() },
              "second",
            ),
        );
        expect(a.error).toBeUndefined();
        if (sameKey) {
          expect(b.error).toBeUndefined();
          expect(b.value).toEqual(a.value);
        } else
          expect(b.error).toMatchObject({
            status: 409,
            response: { code: "receiving_already_finalized" },
          });
        expect((await state()).lots).toHaveLength(2);
        expect((await state()).receipts).toHaveLength(2);
        expect(
          (
            await f.pool.query(
              "SELECT actor_user_id,target_type,target_id,outcome,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.finalized'",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          {
            actor_user_id: c.actor,
            target_type: "traceability_event",
            target_id: saved.id,
            outcome: "success",
            request_id: "first",
          },
        ]);
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
          basisVersion: 2,
          supportCount: 1,
        });
      },
    );

    it.each([true, false])(
      "serializes original finalization versus void in both orders (finalize first=%s)",
      async (finalizeFirst) => {
        const saved = await create(),
          { original } = await commands(saved.id),
          initial = await state();
        const freeze = () => finalize(saved.id, original),
          voidDraft = () => cancel(saved.id, 1, 1);
        const [a, b] = await compete<ReceivingCommandResult, ReceivingCommandResult>(
          saved.id,
          finalizeFirst ? freeze : voidDraft,
          finalizeFirst ? voidDraft : freeze,
        );
        expect(a.error).toBeUndefined();
        expect(b.error).toMatchObject({
          status: 409,
          response: {
            code: "receiving_lifecycle_conflict",
            rootId: saved.id,
            lifecycleVersion: 2,
            currentEventId: finalizeFirst ? saved.id : null,
            pendingDraftId: null,
          },
        });
        const after = await state();
        expect(after.receipts).toHaveLength(2);
        expect(after.lots).toHaveLength(finalizeFirst ? 2 : 1);
        expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toMatchObject({
          status: finalizeFirst ? "finalized" : "void",
          lifecycle: { lifecycleVersion: 2 },
        });
        if (!finalizeFirst) expect(after.lots).toEqual(initial.lots);
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
          basisVersion: finalizeFirst ? 2 : 1,
          supportCount: finalizeFirst ? 1 : 0,
        });
      },
    );

    it.each([true, false])(
      "serializes original finalization versus save in both orders (finalize first=%s)",
      async (finalizeFirst) => {
        const saved = await create(),
          { original } = await commands(saved.id),
          initial = await state();
        const freeze = () => finalize(saved.id, original);
        const save = () =>
          store.saveOriginalDraftCommand(
            c.tenant,
            c.actor,
            saved.id,
            {
              operationKey: randomUUID(),
              expectedDraftVersion: 1,
              draft: { ...c.draft, notes: "Concurrent edit" },
            },
            "save",
          );
        const [a, b] = await compete<ReceivingCommandResult, ReceivingCommandResult>(
          saved.id,
          finalizeFirst ? freeze : save,
          finalizeFirst ? save : freeze,
        );
        expect(a.error).toBeUndefined();
        expect(b.error).toMatchObject({
          status: 409,
          response: {
            code: finalizeFirst ? "receiving_already_finalized" : "receiving_draft_conflict",
          },
        });
        const after = await state();
        expect(after.receipts).toHaveLength(2);
        expect(after.lots).toHaveLength(finalizeFirst ? 2 : 1);
        expect(await store.getLiveRecord(c.tenant, c.actor, saved.id)).toMatchObject({
          status: finalizeFirst ? "finalized" : "draft",
          draftVersion: finalizeFirst ? 1 : 2,
          lifecycle: { lifecycleVersion: finalizeFirst ? 2 : 1 },
        });
        if (!finalizeFirst) expect(after.lots).toEqual(initial.lots);
      },
    );

    it("finalizes a supported original command as v3 with exact audit, bindings and receipt", async () => {
      const saved = await create(),
        { original } = await commands(saved.id);
      const before = await store.getLiveRecord(c.tenant, c.actor, saved.id);
      const result = versioned(await finalize(saved.id, original));
      expect(receivingFinalizeResultSchema.parse(result)).toEqual(result);
      expect(result).toMatchObject({
        receiptVersion: 2,
        command: "receiving.finalize",
        operationKey: original.operationKey,
        eventId: saved.id,
        record: {
          revision: 1,
          draftVersion: 1,
          status: "finalized",
          lifecycle: {
            rootId: saved.id,
            lifecycleVersion: 2,
            currentEventId: saved.id,
            pendingDraftId: null,
          },
          content: {
            kind: "finalized",
            snapshot: {
              snapshotVersion: 3,
              confirmation: {
                ruleVersion: "receiving-readiness-v4",
                inputDigest: original.expectedInputDigest,
                reviewedExemptLines: [],
              },
              items: [
                { lotBinding: { kind: "created" } },
                { lotBinding: { kind: "linked" }, lotId: c.lot },
              ],
            },
          },
        },
      });
      expect(result.inputDigest).toBe(
        digest({
          commandVersion: 2,
          command: "receiving.finalize",
          eventId: saved.id,
          input: finalizeReceivingSchema.parse(original),
        }),
      );
      if (result.record.content.kind !== "finalized") throw new Error("Expected frozen content");
      const lineLots = result.record.content.snapshot.items.map(({ lineNo, lotId }) => ({
        lineNo,
        lotId,
      }));
      expect(
        (
          await f.pool.query(
            "SELECT organization_id,actor_user_id,action,outcome,target_type,target_id,before,after,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.finalized'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          organization_id: c.tenant,
          actor_user_id: c.actor,
          action: "traceability.receiving.finalized",
          outcome: "success",
          target_type: "traceability_event",
          target_id: saved.id,
          before,
          after: {
            rootId: saved.id,
            revision: 1,
            reason: null,
            result: "finalized",
            effect: null,
            record: result.record,
            predecessor: null,
            lineLots: { before: [], after: lineLots },
          },
          request_id: "finalize",
        },
      ]);
      expect(
        (
          await f.pool.query(
            "SELECT command,operation_key,input_digest,event_id,result FROM receiving_operations WHERE tenant_id=$1 AND command='receiving.finalize'",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          command: "receiving.finalize",
          operation_key: original.operationKey,
          input_digest: result.inputDigest,
          event_id: saved.id,
          result,
        },
      ]);
      expect((await state()).lots).toHaveLength(2);
      for (const line of lineLots)
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, line.lotId, {})).toMatchObject({
          basisVersion: 2,
          supportCount: 1,
        });
      expect(
        (
          await f.pool.query(
            "SELECT tlc,product_id,source_location_id,source_locked_at,assignment_basis,status,revision,receiving_basis_version FROM traceability_lots WHERE tenant_id=$1 ORDER BY tlc",
            [c.tenant],
          )
        ).rows,
      ).toEqual([
        {
          tlc: "00001",
          product_id: c.product,
          source_location_id: c.location,
          source_locked_at: new Date(result.record.content.finalizedAt),
          assignment_basis: "imported",
          status: "active",
          revision: 2,
          receiving_basis_version: 2,
        },
        {
          tlc: "000NEW",
          product_id: c.product,
          source_location_id: c.location,
          source_locked_at: new Date(result.record.content.finalizedAt),
          assignment_basis: "imported",
          status: "active",
          revision: 1,
          receiving_basis_version: 2,
        },
      ]);
      const after = await state();
      expect(await finalize(saved.id.toUpperCase(), original, "retry")).toEqual(result);
      expect(await state()).toEqual(after);
    });

    it("requires an exact fresh exemption review before assigning and freezing an own TLC", async () => {
      c = await seedExemptReceiving(f.db);
      const saved = await create(),
        { original } = await commands(saved.id);
      const before = await state();
      for (const reviewedExemptLines of [undefined, [], [2], [1, 2]]) {
        const input = {
          ...original,
          ...(reviewedExemptLines === undefined ? {} : { reviewedExemptLines }),
        };
        await expect(finalize(saved.id, input)).rejects.toMatchObject({
          status: 409,
          response: {
            code: "event_incomplete",
            issues: expect.arrayContaining([
              expect.objectContaining({ code: "exemption_review_required" }),
            ]),
          },
        });
      }
      expect(await state()).toEqual(before);
      const result = versioned(await finalize(saved.id, { ...original, reviewedExemptLines: [1] }));
      expect(result.record.content).toMatchObject({
        kind: "finalized",
        snapshot: {
          snapshotVersion: 3,
          confirmation: { reviewedExemptLines: [1] },
          items: [
            {
              tlc: "=Own/Ä-001",
              lotBinding: { kind: "created" },
              receiptBasis: { kind: "exempt_assigned_tlc", reviewedBy: c.actor },
            },
            { lotId: c.lot },
          ],
        },
      });
      expect((await state()).lots).toHaveLength(2);
    });

    it("accepts explicit revision commands without changing their existing digest or replay", async () => {
      const saved = await create(),
        { original, revision } = await commands(saved.id);
      const before = await state();
      await expect(
        store.finalizeRevision(c.tenant, c.actor, saved.id, original, "strict-original-denial"),
      ).rejects.toMatchObject({ status: 400 });
      expect(await state()).toEqual(before);
      const result = versioned(await finalize(saved.id, revision));
      expect(result.inputDigest).toBe(
        digest({
          commandVersion: 2,
          command: "receiving.finalize",
          eventId: saved.id,
          input: finalizeReceivingRevisionSchema.parse(revision),
        }),
      );
      const after = await state();
      expect(
        await store.finalizeRevision(c.tenant, c.actor, saved.id, revision, "existing-replay"),
      ).toEqual(result);
      expect(await finalize(saved.id, revision, "bridge-replay")).toEqual(result);
      expect(await state()).toEqual(after);
    });

    it("never authorizes an amendment with legacy input, but permits its explicit v2 command", async () => {
      const { result: old } = await oldFinalization();
      const changed = await amend(old.id),
        { original, revision } = await commands(changed.eventId);
      const before = await state();
      await expect(finalize(changed.eventId, original)).rejects.toMatchObject({
        status: 409,
        response: {
          code: "receiving_lifecycle_conflict",
          rootId: old.id,
          lifecycleVersion: 3,
          currentEventId: old.id,
          pendingDraftId: changed.eventId,
        },
      });
      expect(await state()).toEqual(before);
      const result = versioned(await finalize(changed.eventId, revision));
      expect(result.record).toMatchObject({
        revision: 2,
        status: "finalized",
        lifecycle: {
          lifecycleVersion: 4,
          previousRevisionId: old.id,
          currentEventId: changed.eventId,
        },
      });
      expect((await state()).lots).toHaveLength(2);
      expect((await store.getLiveRecord(c.tenant, c.actor, old.id)).status).toBe("amended");
    });

    it.each([1, 2] as const)(
      "replays a version-pinned legacy v%s result after amendment and void without rewriting history",
      async (version) => {
        const p = await oldFinalization();
        let result = p.result;
        if (version === 1) {
          // Synthetic historical specimen, not a claim of an old production deployment.
          if (result.snapshot.snapshotVersion !== 2) throw new Error("Expected legacy v2 writer");
          const snapshot = {
            ...result.snapshot,
            snapshotVersion: 1,
            items: result.snapshot.items.map(({ receiptBasis, ...line }) => {
              void receiptBasis;
              return line;
            }),
            confirmation: {
              ruleVersion: "receiving-readiness-v2",
              inputDigest: result.snapshot.confirmation.inputDigest,
              warnings: result.snapshot.confirmation.warnings,
            },
          };
          result = receivingFinalizedRecordSchema.parse({ ...result, snapshot });
          const connection = await f.pool.connect();
          try {
            await connection.query("BEGIN; SET LOCAL session_replication_role='replica'");
            await connection.query(
              "UPDATE traceability_events SET finalization_snapshot=$3 WHERE tenant_id=$1 AND id=$2",
              [c.tenant, result.id, snapshot],
            );
            await connection.query(
              "UPDATE receiving_operations SET result=$3 WHERE tenant_id=$1 AND operation_key=$2",
              [c.tenant, p.input.operationKey, result],
            );
            await connection.query("COMMIT");
          } finally {
            await connection.query("ROLLBACK");
            connection.release();
          }
        }
        const storedDigest = digest({
          eventId: result.id,
          expectedDraftVersion: p.input.expectedDraftVersion,
          expectedInputDigest: p.input.expectedInputDigest,
        });
        const changed = await amend(result.id),
          { revision } = await commands(changed.eventId);
        await store.finalizeRevision(
          c.tenant,
          c.actor,
          changed.eventId,
          revision,
          "revision-finalize",
        );
        for (const voided of [false, true]) {
          if (voided) await cancel(changed.eventId, 4, null);
          const before = await state();
          expect(await finalize(result.id, p.input, "old-replay")).toEqual(result);
          expect(
            await finalize(result.id, { ...p.input, reviewedExemptLines: [] }, "old-empty-review"),
          ).toEqual(result);
          expect(await state()).toEqual(before);
          expect(
            (
              await f.pool.query(
                "SELECT input_digest,result FROM receiving_operations WHERE tenant_id=$1 AND operation_key=$2",
                [c.tenant, p.input.operationKey],
              )
            ).rows,
          ).toEqual([{ input_digest: storedDigest, result }]);
          expect((await store.getLiveRecord(c.tenant, c.actor, result.id)).status).toBe("amended");
        }
      },
    );

    it("replays a new original receipt after real supersession and void, without live reference revalidation", async () => {
      const saved = await create(),
        { original } = await commands(saved.id);
      const result = await finalize(saved.id, original);
      const changed = await amend(saved.id),
        { revision } = await commands(changed.eventId);
      await finalize(changed.eventId, revision);
      await cancel(changed.eventId, 4, null);
      await f.pool.query(
        "UPDATE traceability_locations SET business_name='Changed historical label' WHERE tenant_id=$1",
        [c.tenant],
      );
      const before = await state();
      expect(await finalize(saved.id, original, "historical-replay")).toEqual(result);
      await expect(
        finalize(saved.id, { ...original, reviewedExemptLines: [] }),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_operation_conflict" } });
      await expect(finalize(randomUUID(), original)).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_operation_conflict" },
      });
      expect(await state()).toEqual(before);
    });

    it("rejects old readiness for a new v3 write, then accepts a fresh v4 check with the same unreserved key", async () => {
      const saved = await create();
      const old = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      const { original } = await commands(saved.id),
        before = await state();
      await expect(
        finalize(saved.id, { ...original, expectedInputDigest: old.inputDigest }),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_readiness_changed" } });
      expect(await state()).toEqual(before);
      expect(versioned(await finalize(saved.id, original)).record.status).toBe("finalized");
    });

    it("detects current reference changes without creating lots or receipts", async () => {
      const saved = await create(),
        { original } = await commands(saved.id);
      await f.pool.query(
        "UPDATE traceability_locations SET business_name='Renamed supplier' WHERE tenant_id=$1",
        [c.tenant],
      );
      const before = await state();
      await expect(finalize(saved.id, original)).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_readiness_changed" },
      });
      expect(await state()).toEqual(before);
    });

    it("keeps stale and terminal original conflicts precise", async () => {
      const saved = await create(),
        { original } = await commands(saved.id);
      await store.saveDraft(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: { ...c.draft, notes: "Updated" },
        },
        "save",
      );
      const before = await state();
      await expect(finalize(saved.id, original)).rejects.toMatchObject({
        status: 409,
        response: { code: "receiving_draft_conflict" },
      });
      expect(await state()).toEqual(before);
      const next = await commands(saved.id, 2);
      await finalize(saved.id, next.original);
      await expect(
        finalize(saved.id, { ...next.original, operationKey: randomUUID() }),
      ).rejects.toMatchObject({ status: 409, response: { code: "receiving_already_finalized" } });
      await cancel(saved.id, 2, null);
      const after = await state();
      await expect(
        finalize(saved.id, { ...next.original, operationKey: randomUUID() }),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          code: "receiving_lifecycle_conflict",
          lifecycleVersion: 3,
          currentEventId: null,
          pendingDraftId: null,
        },
      });
      expect(await state()).toEqual(after);
    });

    it.each(["legacy", "versioned"] as const)(
      "requires current QA before %s replay or input disclosure",
      async (format) => {
        const p =
          format === "legacy"
            ? await oldFinalization()
            : await (async () => {
                const saved = await create(),
                  { original } = await commands(saved.id);
                await finalize(saved.id, original);
                return { input: original, result: { id: saved.id } };
              })();
        await f.db
          .update(schema.member)
          .set({ role: "traceability_receiving" })
          .where(eq(schema.member.id, c.member));
        const before = await state();
        await expect(finalize(p.result.id, p.input)).rejects.toMatchObject({ status: 403 });
        await expect(finalize("invalid", {})).rejects.toMatchObject({ status: 403 });
        expect(await state()).toEqual(before);
      },
    );

    it("rejects partial revision commands without falling back to original input and hides foreign targets", async () => {
      const saved = await create(),
        { original, revision } = await commands(saved.id);
      const foreign = await seedCompleteReceiving(f.db);
      const other = await store.createDraft(
        foreign.tenant,
        foreign.actor,
        { operationKey: randomUUID(), draft: foreign.draft },
        "foreign",
      );
      const before = await state();
      for (const input of [
        { ...original, commandVersion: 2 },
        { ...original, expectedLifecycleVersion: 1 },
        { ...revision, commandVersion: 99 },
      ])
        await expect(finalize(saved.id, input)).rejects.toMatchObject({ status: 400 });
      for (const id of [other.id, randomUUID()])
        await expect(finalize(id, original)).rejects.toMatchObject({ status: 404 });
      expect(await state()).toEqual(before);
    });

    it.each(["legacy", "versioned"] as const)(
      "fails closed on corrupt %s stored results and cannot rebind a successful key",
      async (format) => {
        const p = await oldFinalization();
        if (format === "versioned") {
          // Use a second independent Receiving on an existing lot to avoid a new-TLC collision.
          const linked = c.draft.items[1];
          if (!linked) throw new Error("Missing linked line");
          c.draft.items = [linked];
        }
        const saved = format === "legacy" ? null : await create();
        const input = saved ? (await commands(saved.id)).original : p.input;
        const id = saved?.id ?? p.result.id;
        const result = saved ? await finalize(id, input) : p.result;
        const before = await state();
        await expect(finalize(id, { ...input, expectedDraftVersion: 2 })).rejects.toMatchObject({
          status: 409,
          response: { code: "receiving_operation_conflict" },
        });
        await expect(
          finalize(id, {
            ...input,
            commandVersion: 2,
            expectedLifecycleVersion: 1,
            previousRevisionId: null,
            reviewedExemptLines: [],
          }),
        ).rejects.toMatchObject({
          status: 409,
          response: { code: "receiving_operation_conflict" },
        });
        expect(await state()).toEqual(before);
        const corruptions =
          "receiptVersion" in result
            ? [
                { ...result, receiptVersion: 99 },
                { ...result, command: "receiving.save" },
                { ...result, operationKey: randomUUID() },
                { ...result, eventId: randomUUID() },
                { ...result, inputDigest: "0".repeat(64) },
                {},
              ]
            : [
                { ...result, id: randomUUID() },
                { ...result, snapshot: { ...result.snapshot, snapshotVersion: 99 } },
                { ...result, receiptVersion: 2 },
                {},
              ];
        for (const corrupted of corruptions) {
          await f.pool.query(
            "UPDATE receiving_operations SET result=$3 WHERE tenant_id=$1 AND operation_key=$2",
            [c.tenant, input.operationKey, corrupted],
          );
          const beforeCorruptReplay = await state();
          await expect(finalize(id, input)).rejects.toMatchObject({
            status: 503,
            response: { code: "us_database_unavailable" },
          });
          expect(await state()).toEqual(beforeCorruptReplay);
        }
      },
    );

    it.each(["tenant_audit_events", "receiving_operations"] as const)(
      "rolls back every finalization write when %s fails, allowing exact retry",
      async (table) => {
        const saved = await create(),
          { original } = await commands(saved.id),
          before = await state();
        await f.pool.query(
          `CREATE FUNCTION synthetic_finalize_bridge_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic finalization bridge failure'; END $$; CREATE TRIGGER synthetic_finalize_bridge_fail BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION synthetic_finalize_bridge_fail()`,
        );
        try {
          await expect(finalize(saved.id, original)).rejects.toBeDefined();
        } finally {
          await f.pool.query(
            `DROP TRIGGER synthetic_finalize_bridge_fail ON ${table}; DROP FUNCTION synthetic_finalize_bridge_fail()`,
          );
        }
        expect(await state()).toEqual(before);
        expect(versioned(await finalize(saved.id, original)).record.status).toBe("finalized");
      },
    );
  },
);
