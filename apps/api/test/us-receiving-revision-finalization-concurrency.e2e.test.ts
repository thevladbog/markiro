import { randomUUID } from "node:crypto";
import { receivingAmendmentDraftSchema } from "@markiro/platform-contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)(
  "Receiving revision finalization real transaction races",
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
    async function original(draft = c.draft) {
      const saved = await store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft },
        "create",
      );
      const ready = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      return {
        id: saved.id,
        command: {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: ready.inputDigest,
        },
      };
    }
    async function start() {
      const old = await original();
      await store.finalize(c.tenant, c.actor, old.id, old.command, "original-finalize");
      const amendment = await store.amend(
        c.tenant,
        c.actor,
        old.id,
        {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedLifecycleVersion: 2,
          reason: "Correct receipt",
        },
        "amend",
      );
      const ready = await store.checkRevisionReadiness(c.tenant, c.actor, amendment.eventId, {
        expectedDraftVersion: 1,
      });
      if (amendment.record.content.kind !== "draft") throw new Error("Missing draft");
      return {
        old,
        amendment,
        draft: receivingAmendmentDraftSchema.parse(amendment.record.content.draft),
        command: {
          commandVersion: 2,
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedLifecycleVersion: 3,
          previousRevisionId: old.id,
          expectedInputDigest: ready.inputDigest,
          reviewedExemptLines: ready.exemptReviewRequiredLines,
        },
      };
    }
    async function compete<A, B>(
      kind: "root" | "lot",
      id: string,
      first: () => Promise<A>,
      second: () => Promise<B>,
    ) {
      const gate = await f.pool.connect();
      await gate.query("BEGIN");
      const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      if (!pid) throw new Error("Missing barrier");
      await gate.query(
        `SELECT id FROM ${kind === "root" ? "receiving_event_roots" : "traceability_lots"} WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
        [c.tenant, id],
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
      const a = outcome(first());
      let b: ReturnType<typeof outcome<B>> | undefined;
      try {
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
    const businessLots = async () =>
      (
        await f.pool.query(
          "SELECT to_jsonb(l)-'receiving_basis_version' AS lot FROM traceability_lots l WHERE tenant_id=$1 ORDER BY id",
          [c.tenant],
        )
      ).rows;
    it.each([true, false])(
      "accepts one finalization effect and replays only the same key (same=%s)",
      async (same) => {
        const { old, amendment, command } = await start(),
          before = await businessLots();
        const [a, b] = await compete(
          "root",
          old.id,
          () => store.finalizeRevision(c.tenant, c.actor, amendment.eventId, command, "first"),
          () =>
            store.finalizeRevision(
              c.tenant,
              c.actor,
              amendment.eventId,
              same ? command : { ...command, operationKey: randomUUID() },
              "second",
            ),
        );
        expect(a.error).toBeUndefined();
        if (same) {
          expect(b.error).toBeUndefined();
          expect(b.value).toEqual(a.value);
        } else
          expect(b.error).toMatchObject({
            status: 409,
            response: { code: "receiving_lifecycle_conflict" },
          });
        expect(await businessLots()).toEqual(before);
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
          basisVersion: 3,
          supportCount: 1,
          items: [{ eventId: amendment.eventId }],
        });
        expect(
          (
            await f.pool.query(
              "SELECT actor_user_id,target_id,outcome,request_id FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.finalized' AND target_id=$2",
              [c.tenant, amendment.eventId],
            )
          ).rows,
        ).toEqual([
          {
            actor_user_id: c.actor,
            target_id: amendment.eventId,
            outcome: "success",
            request_id: "first",
          },
        ]);
      },
    );
    it.each([true, false])(
      "serializes finalization versus draft cancellation (finalize first=%s)",
      async (finalizeFirst) => {
        const { old, amendment, command } = await start(),
          before = await businessLots();
        const finalize = () =>
          store.finalizeRevision(c.tenant, c.actor, amendment.eventId, command, "finalize");
        const cancel = () =>
          store.void(
            c.tenant,
            c.actor,
            amendment.eventId,
            {
              commandVersion: 2,
              operationKey: randomUUID(),
              expectedLifecycleVersion: 3,
              expectedDraftVersion: 1,
              reason: "Cancel correction",
            },
            "cancel",
          );
        const [a, b] = await compete(
          "root",
          old.id,
          finalizeFirst ? finalize : cancel,
          finalizeFirst ? cancel : finalize,
        );
        expect(a.error).toBeUndefined();
        expect(b.error).toMatchObject({
          status: 409,
          response: { code: "receiving_lifecycle_conflict" },
        });
        expect(await businessLots()).toEqual(before);
        expect(await store.getLiveRecord(c.tenant, c.actor, amendment.eventId)).toMatchObject({
          status: finalizeFirst ? "finalized" : "void",
          lifecycle: {
            lifecycleVersion: 4,
            currentEventId: finalizeFirst ? amendment.eventId : old.id,
            pendingDraftId: null,
          },
        });
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
          basisVersion: finalizeFirst ? 3 : 2,
          supportCount: 1,
          items: [{ eventId: finalizeFirst ? amendment.eventId : old.id }],
        });
      },
    );
    it.each([true, false])(
      "serializes finalization versus changed save (finalize first=%s)",
      async (finalizeFirst) => {
        const { old, amendment, draft, command } = await start(),
          before = await businessLots();
        const finalize = () =>
          store.finalizeRevision(c.tenant, c.actor, amendment.eventId, command, "finalize");
        const save = () =>
          store.saveAmendment(
            c.tenant,
            c.actor,
            amendment.eventId,
            {
              commandVersion: 2,
              operationKey: randomUUID(),
              expectedLifecycleVersion: 3,
              expectedDraftVersion: 1,
              draft: { ...draft, notes: "Corrected while checking" },
            },
            "save",
          );
        const [a, b] = await compete(
          "root",
          old.id,
          finalizeFirst ? finalize : save,
          finalizeFirst ? save : finalize,
        );
        expect(a.error).toBeUndefined();
        expect(b.error).toMatchObject({
          status: 409,
          response: {
            code: finalizeFirst ? "receiving_lifecycle_conflict" : "receiving_draft_conflict",
          },
        });
        expect(await businessLots()).toEqual(before);
        expect(await store.getLiveRecord(c.tenant, c.actor, amendment.eventId)).toMatchObject({
          status: finalizeFirst ? "finalized" : "draft",
          draftVersion: finalizeFirst ? 1 : 2,
          lifecycle: { lifecycleVersion: finalizeFirst ? 4 : 3 },
        });
      },
    );
    it.each([true, false])(
      "coordinates independent legacy receipt support (amendment first=%s)",
      async (amendmentFirst) => {
        const { amendment, command } = await start();
        const other = await original({
          ...c.draft,
          items: c.draft.items.filter((line) => line.lotId === c.lot),
        });
        const before = await businessLots();
        const finalize = () =>
          store.finalizeRevision(
            c.tenant,
            c.actor,
            amendment.eventId,
            command,
            "amendment-finalize",
          );
        const legacy = () =>
          store.finalize(c.tenant, c.actor, other.id, other.command, "legacy-finalize");
        // Separate roots meet at the common lot token; no cross-root locks.
        const [a, b] = amendmentFirst
          ? await compete("lot", c.lot, finalize, legacy)
          : await compete("lot", c.lot, legacy, finalize);
        expect(a.error).toBeUndefined();
        if (amendmentFirst) expect(b.error).toBeUndefined();
        else
          expect(b.error).toMatchObject({
            status: 409,
            response: { code: "receiving_readiness_changed" },
          });
        expect(await businessLots()).toEqual(before);
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
          supportCount: 2,
          basisVersion: amendmentFirst ? 4 : 3,
        });
        expect(await store.getLiveRecord(c.tenant, c.actor, amendment.eventId)).toMatchObject({
          status: amendmentFirst ? "finalized" : "draft",
        });
      },
    );
    it("reads old basis and token from one snapshot during actual amendment finalization", async () => {
      const { amendment, command } = await start();
      const before = await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {});
      const transaction = f.db.transaction.bind(f.db);
      const hook = vi.spyOn(f.db, "transaction").mockImplementationOnce((run, options) =>
        transaction(async (tx) => {
          await tx.execute(sql`SELECT id FROM traceability_lots WHERE tenant_id=${c.tenant}`);
          await store.finalizeRevision(
            c.tenant,
            c.actor,
            amendment.eventId,
            command,
            "concurrent-finalize",
          );
          return run(tx);
        }, options),
      );
      try {
        expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toEqual(before);
      } finally {
        hook.mockRestore();
      }
      expect(await store.getLotReceivingBasis(c.tenant, c.actor, c.lot, {})).toMatchObject({
        basisVersion: 3,
        supportCount: 1,
        items: [{ eventId: amendment.eventId }],
      });
    });
  },
);
