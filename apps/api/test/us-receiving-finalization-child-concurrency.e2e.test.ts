import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)(
  "Receiving child mutations invalidate waiting repeatable-read finalizers",
  { timeout: 15000 },
  () => {
    let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
    let store: UsReceivingStore;
    let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
    beforeAll(async () => {
      if (!url) throw new Error("Missing synthetic database");
      fixture = await createUsProfileTestDatabase(url);
      store = new UsReceivingStore(fixture.db);
    }, 60000);
    afterAll(async () => {
      await fixture?.close();
    });
    beforeEach(async () => {
      c = await seedCompleteReceiving(fixture.db);
    });
    async function save(draft = c.draft) {
      const saved = await store.createDraft(
        c.tenant,
        c.actor,
        { operationKey: randomUUID(), draft },
        "create",
      );
      const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
        expectedDraftVersion: 1,
      });
      expect(checked.state).toBe("complete");
      return {
        saved,
        command: {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: checked.inputDigest,
        },
      };
    }
    async function businessState() {
      return (
        await fixture.pool.query(
          "SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM traceability_events e WHERE e.tenant_id=$1) AS headers, (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.year) FROM receiving_counters c WHERE c.tenant_id=$1) AS counters, (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation_key) FROM receiving_operations r WHERE r.tenant_id=$1) AS receipts, (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM tenant_audit_events a WHERE a.organization_id=$1) AS audit, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM traceability_lots l WHERE l.tenant_id=$1) AS lots",
          [c.tenant],
        )
      ).rows;
    }
    async function race(
      target: Awaited<ReturnType<typeof save>>,
      query: string,
      params: unknown[],
      code = "receiving_readiness_changed",
    ) {
      const before = await businessState();
      const gate = await fixture.pool.connect();
      let pending: ReturnType<typeof outcome> | undefined;
      try {
        await gate.query("BEGIN");
        const pid = (await gate.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing barrier identity");
        await gate.query(query, params);
        pending = outcome(
          store.finalize(c.tenant, c.actor, target.saved.id, target.command, "waiting-finalizer"),
        );
        await expect
          .poll(
            async () => {
              const result = await fixture.pool.query<{ blocked: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))) AS blocked",
                [pid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 5000 },
          )
          .toBe(true);
        await gate.query("COMMIT");
        expect((await pending).error).toMatchObject({ status: 409, response: { code } });
        // MVCC coordination must not change even timestamp precision, versions, receipts, counters or audit.
        expect(await businessState()).toEqual(before);
      } finally {
        await gate.query("ROLLBACK");
        gate.release();
        await pending;
      }
    }
    it.each([
      "document insert",
      "document update",
      "document delete",
      "item insert",
      "item delete",
      "item update",
    ] as const)("rejects the old confirmation after a committed raw %s", async (kind) => {
      const target = await save();
      const document = randomUUID();
      await fixture.db.insert(schema.referenceDocuments).values({
        id: document,
        tenantId: c.tenant,
        type: "bol",
        number: "SECOND",
        createdBy: c.actor,
      });
      if (kind === "document insert")
        await race(
          target,
          "INSERT INTO receiving_event_documents(tenant_id,event_id,position,document_id) VALUES ($1,$2,2,$3)",
          [c.tenant, target.saved.id, document],
        );
      if (kind === "document update")
        await race(
          target,
          "UPDATE receiving_event_documents SET document_id=$1 WHERE event_id=$2",
          [document, target.saved.id],
        );
      if (kind === "document delete")
        await race(
          target,
          "DELETE FROM receiving_event_documents WHERE event_id=$1",
          [target.saved.id],
          "event_incomplete",
        );
      if (kind === "item delete")
        await race(target, "DELETE FROM receiving_event_items WHERE event_id=$1 AND line_no=2", [
          target.saved.id,
        ]);
      if (kind === "item update")
        await race(
          target,
          "UPDATE receiving_event_items SET quantity='2.500' WHERE event_id=$1 AND line_no=1",
          [target.saved.id],
        );
      if (kind === "item insert")
        await race(
          target,
          "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,product_id,lot_link_mode,tlc,quantity,unit_of_measure,source_location_id,exempt_supplier) VALUES ($1,$2,3,$3,'create_on_finalize','THIRD','3.000','lb',$4,false)",
          [c.tenant, target.saved.id, c.product, c.location],
        );
    });
    it.each([
      ["document", "old"],
      ["document", "new"],
      ["item", "old"],
      ["item", "new"],
    ] as const)(
      "invalidates the %s move's %s parent without changing business metadata",
      async (kind, parent) => {
        await fixture.db
          .delete(schema.productTraceabilityProfiles)
          .where(eq(schema.productTraceabilityProfiles.productId, c.product));
        await fixture.db
          .update(schema.traceabilityProfiles)
          .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
          .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
        const first = await save();
        const line = c.draft.items[0];
        if (!line) throw new Error("Missing synthetic line");
        const second = await save({
          ...c.draft,
          documentIds: [],
          items: [{ ...line, tlc: "SECOND" }],
        });
        const target = parent === "old" ? first : second;
        if (kind === "document")
          await race(target, "UPDATE receiving_event_documents SET event_id=$1 WHERE event_id=$2", [
            second.saved.id,
            first.saved.id,
          ]);
        else
          await race(
            target,
            "UPDATE receiving_event_items SET event_id=$1 WHERE event_id=$2 AND line_no=2",
            [second.saved.id, first.saved.id],
          );
      },
    );
  },
);
