import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { UsProductProfileStore } from "../src/modules/traceability/products/us-product-profile-store";
import { editableProfile } from "../src/modules/traceability/products/us-product-profile-support";
import { UsLotStore } from "../src/modules/traceability/lots/us-lot-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)("ordinary receiving real transaction races", { timeout: 15000 }, () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing synthetic database");
    fixture = await createUsProfileTestDatabase(url);
    store = new UsReceivingStore(fixture.db);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  beforeEach(async () => {
    c = await seedCompleteReceiving(fixture.db);
  });
  async function ready() {
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft: c.draft },
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
  async function barrier(query: string, params: unknown[]) {
    const connection = await fixture.pool.connect();
    await connection.query("BEGIN");
    const identity = await connection.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const pid = identity.rows[0]?.pid;
    if (!pid) throw new Error("Missing barrier identity");
    await connection.query(query, params);
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
          const result = await fixture.pool.query<{ count: number }>(
            "WITH RECURSIVE blocked(pid) AS (SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid)) UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int AS count FROM blocked",
            [pid],
          );
          return result.rows[0]?.count ?? 0;
        },
        { timeout: 5000 },
      )
      .toBeGreaterThanOrEqual(count);
  }
  it.each([true, false])(
    "serializes competing finalizers (same key=%s) without duplicate business effects",
    async (same) => {
      const { saved, command } = await ready();
      const gate = await barrier("SELECT id FROM traceability_events WHERE id=$1 FOR UPDATE", [
        saved.id,
      ]);
      const first = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "first"));
      await waitFor(gate.pid);
      const second = outcome(
        store.finalize(
          c.tenant,
          c.actor,
          saved.id,
          same ? command : { ...command, operationKey: randomUUID() },
          "second",
        ),
      );
      try {
        if (!same) await waitFor(gate.pid, 2);
        await gate.connection.query("COMMIT");
        const [a, b] = await Promise.all([first, second]);
        expect(a.error).toBeUndefined();
        if (same) {
          expect(b.error).toBeUndefined();
          expect(b.value).toEqual(a.value);
        } else
          expect(b.error).toMatchObject({
            status: 409,
            response: { code: "receiving_already_finalized" },
          });
        expect(
          await fixture.db
            .select()
            .from(schema.traceabilityLots)
            .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
        ).toHaveLength(2);
        const audits = await fixture.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
        expect(audits.filter((a) => a.action === "traceability.receiving.finalized")).toHaveLength(
          1,
        );
        expect(audits.filter((a) => a.action === "traceability.lot.source_locked")).toHaveLength(1);
      } finally {
        await gate.close();
        await Promise.all([first, second]);
      }
    },
  );
  it("retries a whole transaction after a saved draft wins the event lock", async () => {
    const { saved, command } = await ready();
    const gate = await barrier("SELECT id FROM traceability_events WHERE id=$1 FOR UPDATE", [
      saved.id,
    ]);
    const save = outcome(
      store.saveDraft(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          draft: { ...c.draft, notes: "Concurrent save" },
        },
        "save",
      ),
    );
    await waitFor(gate.pid);
    const finalize = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    try {
      await waitFor(gate.pid, 2);
      await gate.connection.query("COMMIT");
      expect((await save).error).toBeUndefined();
      expect((await finalize).error).toMatchObject({
        status: 409,
        response: { code: "receiving_draft_conflict" },
      });
      expect((await store.getDraft(c.tenant, c.actor, saved.id)).draftVersion).toBe(2);
    } finally {
      await gate.close();
      await Promise.all([save, finalize]);
    }
  });
  it.each([
    ["traceability_lots", "status='quarantined'", "lot"],
    ["traceability_locations", "archived=true", "location"],
    ["product_traceability_profiles", "product_name='Concurrent name'", "product"],
  ] as const)(
    "rechecks current inputs when %s changes ahead of its lock",
    async (table, assignment, key) => {
      const { saved, command } = await ready();
      const idColumn = table === "product_traceability_profiles" ? "product_id" : "id";
      const gate = await barrier(`UPDATE ${table} SET ${assignment} WHERE ${idColumn}=$1`, [
        c[key],
      ]);
      const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
      try {
        await waitFor(gate.pid);
        await gate.connection.query("COMMIT");
        expect((await pending).error).toMatchObject({
          status: 409,
          response: {
            code:
              table === "product_traceability_profiles"
                ? "receiving_readiness_changed"
                : "event_incomplete",
          },
        });
        expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
      } finally {
        await gate.close();
        await pending;
      }
    },
  );
  it("locks selected lots before source correction references and detects the corrected source", async () => {
    const { saved, command } = await ready();
    const gate = await barrier("SELECT id FROM traceability_lots WHERE id=$1 FOR UPDATE", [c.lot]);
    const change = outcome(
      new UsLotStore(fixture.db).changeSource(
        c.tenant,
        c.actor,
        c.lot,
        { expectedRevision: 1, source: null, reason: "Synthetic correction" },
        "correction",
      ),
    );
    await waitFor(gate.pid);
    const finalize = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    try {
      await waitFor(gate.pid, 2);
      await gate.connection.query("COMMIT");
      expect((await change).error).toBeUndefined();
      expect((await finalize).error).toMatchObject({
        status: 409,
        response: { code: "event_incomplete" },
      });
      expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
    } finally {
      await gate.close();
      await Promise.all([change, finalize]);
    }
  });
  it("rolls back a unique identity race against an uncommitted lot creation", async () => {
    const { saved, command } = await ready();
    const lot = randomUUID();
    const gate = await barrier(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,source_location_id,assignment_basis,created_by,updated_by) VALUES ($1,$2,$3,'000NEW',$4,'imported',$5,$5)",
      [lot, c.tenant, c.product, c.location, c.actor],
    );
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    try {
      await waitFor(gate.pid);
      await gate.connection.query("COMMIT");
      expect((await pending).error).toMatchObject({
        status: 409,
        response: { code: "receiving_lot_conflict" },
      });
      expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
      const lots = await fixture.db
        .select()
        .from(schema.traceabilityLots)
        .where(eq(schema.traceabilityLots.tenantId, c.tenant));
      expect(lots).toHaveLength(2);
      expect(lots.find((row) => row.id === c.lot)).toMatchObject({
        revision: 1,
        sourceLockedAt: null,
      });
    } finally {
      await gate.close();
      await pending;
    }
  });
  it("serializes a raw child edit and finalization without freezing mixed data", async () => {
    const { saved, command } = await ready();
    // A selected lot barrier holds finalization after it owns the event header.
    const gate = await barrier("SELECT id FROM traceability_lots WHERE id=$1 FOR UPDATE", [c.lot]);
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    await waitFor(gate.pid);
    const edit = outcome(
      fixture.pool.query(
        "UPDATE receiving_event_items SET quantity='7' WHERE event_id=$1 AND line_no=1",
        [saved.id],
      ),
    );
    try {
      await expect
        .poll(
          async () => {
            const result = await fixture.pool.query<{ waiting: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND query LIKE 'UPDATE receiving_event_items SET quantity%' AND cardinality(pg_blocking_pids(pid))>0) AS waiting",
            );
            return result.rows[0]?.waiting;
          },
          { timeout: 5000 },
        )
        .toBe(true);
      await gate.connection.query("COMMIT");
      const finalized = await pending;
      const edited = await edit;
      if (finalized.value) {
        expect(edited.error).toMatchObject({ code: expect.stringMatching(/^(23514|40P01)$/) });
        expect(finalized.value.snapshot.items[0]?.quantity).toBe("500.000");
        expect((await store.getRecord(c.tenant, c.actor, saved.id)).status).toBe("finalized");
      } else {
        expect(edited.error).toBeUndefined();
        expect(finalized.error).toMatchObject({
          status: 409,
          response: { code: "receiving_readiness_changed" },
        });
        expect((await store.getDraft(c.tenant, c.actor, saved.id)).draft.items[0]?.quantity).toBe(
          "7",
        );
      }
    } finally {
      await gate.close();
      await Promise.all([pending, edit]);
    }
  });
  it("rechecks a first product profile inserted before the finalizer acquires its product lock", async () => {
    await fixture.db
      .delete(schema.productTraceabilityProfiles)
      .where(eq(schema.productTraceabilityProfiles.productId, c.product));
    await fixture.db
      .update(schema.traceabilityProfiles)
      .set({ code: "US_GENERIC_LOT_TRACEABILITY" })
      .where(eq(schema.traceabilityProfiles.tenantId, c.tenant));
    const { saved, command } = await ready();
    const profiles = new UsProductProfileStore(fixture.db);
    const current = await profiles.getProfile(c.tenant, c.actor, c.product);
    const productBefore = await fixture.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, c.product));
    const fields = editableProfile(current);
    const gate = await barrier("SELECT id FROM products WHERE id=$1 FOR UPDATE", [c.product]);
    const insertion = outcome(
      profiles.putProfile(
        c.tenant,
        c.actor,
        c.product,
        { ...fields, productName: "New current profile", expectedRevision: 0 },
        "profile",
      ),
    );
    await waitFor(gate.pid);
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "finalize"));
    try {
      await waitFor(gate.pid, 2);
      await gate.connection.query("COMMIT");
      expect((await insertion).error).toBeUndefined();
      expect((await pending).error).toMatchObject({
        status: 409,
        response: { code: "receiving_readiness_changed" },
      });
      expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
      expect(
        await fixture.db.select().from(schema.products).where(eq(schema.products.id, c.product)),
      ).toEqual(productBefore);
      const audits = await fixture.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.requestId, "profile"));
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        organizationId: c.tenant,
        actorUserId: c.actor,
        targetType: "traceability_product_profile",
        targetId: c.product,
        action: "traceability.product_profile.updated",
        outcome: "success",
        before: current,
        after: (await insertion).value,
      });
    } finally {
      await gate.close();
      await Promise.all([insertion, pending]);
    }
  });
  it("rechecks profile deletion and preserves every parent product value without extra audit", async () => {
    const { saved, command } = await ready();
    const before = await fixture.db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, c.product));
    const audits = await fixture.db
      .select()
      .from(schema.tenantAuditEvents)
      .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    const gate = await barrier(
      "DELETE FROM product_traceability_profiles WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "confirm"));
    try {
      await waitFor(gate.pid);
      await gate.connection.query("COMMIT");
      expect((await pending).error).toMatchObject({
        status: 409,
        response: { code: "event_incomplete" },
      });
      expect(
        await fixture.db.select().from(schema.products).where(eq(schema.products.id, c.product)),
      ).toEqual(before);
      expect(
        await fixture.db
          .select()
          .from(schema.tenantAuditEvents)
          .where(eq(schema.tenantAuditEvents.organizationId, c.tenant)),
      ).toEqual(audits);
    } finally {
      await gate.close();
      await pending;
    }
  });
  it("retries serialization failures at most three whole transactions and leaves no partial effects", async () => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "CREATE SEQUENCE synthetic_receiving_attempts; CREATE FUNCTION synthetic_receiving_serialization() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='finalized' THEN PERFORM nextval('synthetic_receiving_attempts'); RAISE EXCEPTION 'Synthetic serialization' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_receiving_serialization BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION synthetic_receiving_serialization()",
    );
    try {
      expect(
        (await outcome(store.finalize(c.tenant, c.actor, saved.id, command, "retry"))).error,
      ).toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
      expect(
        (
          await fixture.pool.query(
            "SELECT last_value::int AS attempts FROM synthetic_receiving_attempts",
          )
        ).rows,
      ).toEqual([{ attempts: 3 }]);
      expect(await store.getDraft(c.tenant, c.actor, saved.id)).toEqual(saved);
      expect(
        await fixture.db
          .select()
          .from(schema.traceabilityLots)
          .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
      ).toMatchObject([{ id: c.lot, sourceLockedAt: null, revision: 1 }]);
      expect(
        await fixture.db
          .select()
          .from(schema.receivingOperations)
          .where(eq(schema.receivingOperations.tenantId, c.tenant)),
      ).toHaveLength(1);
    } finally {
      await fixture.pool.query(
        "DROP TRIGGER synthetic_receiving_serialization ON traceability_events; DROP FUNCTION synthetic_receiving_serialization(); DROP SEQUENCE synthetic_receiving_attempts",
      );
    }
  });
  it("reloads authorization when the first transaction rolls back and membership is revoked before retry", async () => {
    const { saved, command } = await ready();
    await fixture.pool.query(
      "CREATE SEQUENCE synthetic_receiving_auth_attempts; CREATE FUNCTION synthetic_receiving_auth_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='finalized' AND nextval('synthetic_receiving_auth_attempts')=1 THEN PERFORM pg_advisory_xact_lock(812704); RAISE EXCEPTION 'Synthetic serialization' USING ERRCODE='40001'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_receiving_auth_retry BEFORE UPDATE ON traceability_events FOR EACH ROW EXECUTE FUNCTION synthetic_receiving_auth_retry()",
    );
    const gate = await barrier("SELECT pg_advisory_xact_lock(812704)", []);
    const pending = outcome(store.finalize(c.tenant, c.actor, saved.id, command, "confirm"));
    let revoke: ReturnType<typeof outcome> | undefined;
    try {
      await waitFor(gate.pid);
      revoke = outcome(fixture.pool.query("DELETE FROM member WHERE id=$1", [c.member]));
      await waitFor(gate.pid, 2);
      await gate.connection.query("COMMIT");
      expect((await revoke).error).toBeUndefined();
      expect((await pending).error).toMatchObject({ status: 403 });
      expect(
        (await fixture.pool.query("SELECT status FROM traceability_events WHERE id=$1", [saved.id]))
          .rows,
      ).toEqual([{ status: "draft" }]);
      expect(
        await fixture.db
          .select()
          .from(schema.traceabilityLots)
          .where(eq(schema.traceabilityLots.tenantId, c.tenant)),
      ).toMatchObject([{ id: c.lot, sourceLockedAt: null, revision: 1 }]);
    } finally {
      await gate.close();
      await pending;
      await revoke;
      await fixture.pool.query(
        "DROP TRIGGER synthetic_receiving_auth_retry ON traceability_events; DROP FUNCTION synthetic_receiving_auth_retry(); DROP SEQUENCE synthetic_receiving_auth_attempts",
      );
    }
  });
});
