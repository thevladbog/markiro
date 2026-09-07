import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedExemptReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)("exempt receiving transaction barriers", { timeout: 15000 }, () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedExemptReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedExemptReceiving(fixture.db);
  });
  async function ready() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
      "save",
    );
    const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    expect(checked).toMatchObject({ state: "complete", exemptReviewRequiredLines: [1] });
    return {
      saved,
      command: {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: checked.inputDigest,
        reviewedExemptLines: [1],
      },
    };
  }
  async function business() {
    return (
      await fixture.pool.query(
        "SELECT (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM traceability_events t WHERE tenant_id=$1) headers,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM traceability_lots t WHERE tenant_id=$1) lots,(SELECT jsonb_agg(to_jsonb(t) ORDER BY operation_key) FROM receiving_operations t WHERE tenant_id=$1) receipts,(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tenant_audit_events t WHERE organization_id=$1) audits",
        [c.tenant],
      )
    ).rows;
  }
  async function barrier(query: string, params: unknown[]) {
    const connection = await fixture.pool.connect();
    await connection.query("BEGIN");
    const pid = (await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
      ?.pid;
    if (!pid) throw new Error("Missing barrier");
    try {
      await connection.query(query, params);
    } catch (error) {
      await connection.query("ROLLBACK");
      connection.release();
      throw error;
    }
    return {
      connection,
      pid,
      close: async () => {
        await connection.query("ROLLBACK");
        connection.release();
      },
    };
  }
  async function waitFor(pid: number, count = 1) {
    await expect
      .poll(
        async () => {
          return (
            (
              await fixture.pool.query<{ count: number }>(
                "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS count FROM blocked",
                [pid],
              )
            ).rows[0]?.count ?? 0
          );
        },
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(count);
  }
  it.each([true, false])(
    "creates the own lot once for concurrent finalizers (same key=%s)",
    async (same) => {
      const { saved, command } = await ready();
      const gate = await barrier("SELECT id FROM traceability_events WHERE id=$1 FOR UPDATE", [
        saved.id,
      ]);
      const first = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "first"));
      let second: typeof first | undefined;
      try {
        await waitFor(gate.pid);
        second = outcome(
          store.finalize(
            c.tenant,
            c.actor,
            saved.id,
            same ? command : { ...command, operationKey: randomUUID() },
            "second",
          ),
        );
        await waitFor(gate.pid, 2);
        await gate.connection.query("COMMIT");
        const a = await first,
          b = await second;
        expect(a.error).toBeUndefined();
        if (same) expect(b.value).toEqual(a.value);
        else
          expect(b.error).toMatchObject({
            status: 409,
            response: { code: "receiving_already_finalized" },
          });
        expect(
          (
            await fixture.pool.query(
              "SELECT tlc,assignment_basis,revision FROM traceability_lots WHERE tenant_id=$1 AND id<>$2",
              [c.tenant, c.lot],
            )
          ).rows,
        ).toEqual([
          { tlc: "=Own/Ä-001", assignment_basis: "exempt_supplier_receipt", revision: 1 },
        ]);
        expect(
          (
            await fixture.pool.query(
              "SELECT action,count(*)::int AS count FROM tenant_audit_events WHERE organization_id=$1 AND action<>'traceability.receiving.draft_created' GROUP BY action ORDER BY action",
              [c.tenant],
            )
          ).rows,
        ).toEqual([
          { action: "traceability.lot.created", count: 1 },
          { action: "traceability.lot.source_locked", count: 1 },
          { action: "traceability.receiving.finalized", count: 1 },
        ]);
      } finally {
        await gate.close();
        await first;
        await second;
      }
    },
  );
  it("rolls back an own assignment when a concurrent lot wins its unique source/TLC", async () => {
    const { saved, command } = await ready();
    const before = await business();
    const newId = randomUUID();
    const gate = await barrier(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,source_location_id,assignment_basis,created_by,updated_by) VALUES ($1,$2,$3,'=Own/Ä-001',$4,'imported',$5,$5)",
      [newId, c.tenant, c.product, c.location, c.actor],
    );
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "race"));
    try {
      await waitFor(gate.pid);
      await gate.connection.query("COMMIT");
      expect((await pending).error).toMatchObject({
        status: 409,
        response: { code: "receiving_lot_conflict" },
      });
      expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
      const after = await business();
      expect(
        after.map(({ lots, ...rest }) => {
          void lots;
          return rest;
        }),
      ).toEqual(
        before.map(({ lots, ...rest }) => {
          void lots;
          return rest;
        }),
      );
      expect(
        (
          await fixture.pool.query(
            "SELECT revision,source_locked_at FROM traceability_lots WHERE id=$1",
            [c.lot],
          )
        ).rows,
      ).toEqual([{ revision: 1, source_locked_at: null }]);
    } finally {
      await gate.close();
      await pending;
    }
  });
  async function rejectAfterMutation(
    target: Awaited<ReturnType<typeof ready>>,
    query: string,
    params: unknown[],
    code = "receiving_readiness_changed",
  ) {
    const before = await business();
    const gate = await barrier(query, params);
    const pending = outcome(
      store.finalize(c.tenant, c.actor, target.saved.id, target.command, "waiting"),
    );
    try {
      await waitFor(gate.pid);
      await gate.connection.query("COMMIT");
      expect((await pending).error).toMatchObject({ status: 409, response: { code } });
      expect(await business()).toEqual(before);
    } finally {
      await gate.close();
      await pending;
    }
  }
  it.each(["source", "profile", "document"] as const)(
    "invalidates reviewed exempt inputs when current %s changes",
    async (kind) => {
      const target = await ready();
      const mutations = {
        source: [
          "UPDATE traceability_locations SET business_name='Changed source' WHERE id=$1",
          [c.location],
        ],
        profile: [
          "UPDATE product_traceability_profiles SET product_name='Changed product' WHERE tenant_id=$1 AND product_id=$2",
          [c.tenant, c.product],
        ],
        document: [
          "UPDATE reference_documents SET number='Changed document' WHERE id=$1",
          [c.document],
        ],
      } as const;
      const [query, params] = mutations[kind];
      await rejectAfterMutation(target, query, [...params]);
    },
  );
  it.each([
    "item insert",
    "item update",
    "item delete",
    "document insert",
    "document update",
    "document delete",
  ] as const)("rejects a previously reviewed receipt after concurrent %s", async (kind) => {
    const target = await ready();
    const document = randomUUID();
    await fixture.pool.query(
      "INSERT INTO reference_documents(id,tenant_id,type,number,created_by) VALUES ($1,$2,'bol','SECOND',$3)",
      [document, c.tenant, c.actor],
    );
    if (kind === "item insert")
      await rejectAfterMutation(
        target,
        "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,product_id,lot_link_mode,tlc,quantity,unit_of_measure,source_location_id,exempt_supplier) VALUES ($1,$2,3,$3,'create_on_finalize','THIRD','1','lb',$4,false)",
        [c.tenant, target.saved.id, c.product, c.location],
      );
    if (kind === "item update")
      await rejectAfterMutation(
        target,
        "UPDATE receiving_event_items SET exempt_reason='Changed declaration' WHERE event_id=$1 AND line_no=1",
        [target.saved.id],
      );
    if (kind === "item delete")
      await rejectAfterMutation(
        target,
        "DELETE FROM receiving_event_items WHERE event_id=$1 AND line_no=2",
        [target.saved.id],
      );
    if (kind === "document insert")
      await rejectAfterMutation(
        target,
        "INSERT INTO receiving_event_documents(tenant_id,event_id,position,document_id) VALUES ($1,$2,2,$3)",
        [c.tenant, target.saved.id, document],
      );
    if (kind === "document update")
      await rejectAfterMutation(
        target,
        "UPDATE receiving_event_documents SET document_id=$1 WHERE event_id=$2",
        [document, target.saved.id],
      );
    if (kind === "document delete")
      await rejectAfterMutation(
        target,
        "DELETE FROM receiving_event_documents WHERE event_id=$1",
        [target.saved.id],
        "event_incomplete",
      );
  });
  it.each(["old", "new"] as const)(
    "invalidates the %s parent of a concurrent item move",
    async (parent) => {
      const first = await ready();
      const own = c.draft.items[0];
      if (!own) throw new Error("Missing own line");
      c.draft.items = [own];
      const second = await ready();
      await rejectAfterMutation(
        parent === "old" ? first : second,
        "UPDATE receiving_event_items SET event_id=$1 WHERE event_id=$2 AND line_no=2",
        [second.saved.id, first.saved.id],
      );
    },
  );
  it.each(["old", "new"] as const)(
    "invalidates the %s parent of a concurrent document move",
    async (parent) => {
      await fixture.pool.query(
        "DELETE FROM product_traceability_profiles WHERE tenant_id=$1 AND product_id=$2",
        [c.tenant, c.product],
      );
      await fixture.pool.query(
        "UPDATE traceability_profiles SET code='US_GENERIC_LOT_TRACEABILITY' WHERE tenant_id=$1",
        [c.tenant],
      );
      const first = await ready();
      c.draft.documentIds = [];
      const second = await ready();
      await rejectAfterMutation(
        parent === "old" ? first : second,
        "UPDATE receiving_event_documents SET event_id=$1 WHERE event_id=$2",
        [second.saved.id, first.saved.id],
      );
    },
  );
  it("freezes reviewed evidence against a waiting child edit after finalization owns the header", async () => {
    const { saved, command } = await ready();
    const gate = await barrier("SELECT id FROM traceability_lots WHERE id=$1 FOR UPDATE", [c.lot]);
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    let edit: ReturnType<typeof outcome> | undefined;
    try {
      await waitFor(gate.pid);
      edit = outcome(
        fixture.pool.query(
          "UPDATE receiving_event_items SET exempt_reason='Late edit' WHERE event_id=$1 AND line_no=1",
          [saved.id],
        ),
      );
      await waitFor(gate.pid, 2);
      await gate.connection.query("COMMIT");
      const finalized = await pending,
        edited = await edit;
      if (finalized.value) {
        expect(edited.error).toMatchObject({ code: expect.stringMatching(/^(23514|40P01)$/) });
        expect(finalized.value.snapshot.items[0]).toMatchObject({
          receiptBasis: { reason: "Synthetic receipt-specific supplier declaration" },
        });
      } else {
        expect(edited.error).toBeUndefined();
        expect(finalized.error).toMatchObject({
          status: 409,
          response: { code: "receiving_readiness_changed" },
        });
        expect(
          (await store.getDraft(c.tenant, c.actor, saved.id)).draft.items[0]?.exemptReason,
        ).toBe("Late edit");
      }
    } finally {
      await gate.close();
      await pending;
      await edit;
    }
  });
});
