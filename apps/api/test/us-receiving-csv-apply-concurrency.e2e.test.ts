import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsReceivingCsvStore } from "../src/modules/traceability/receiving/us-receiving-csv-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedReceivingTenant } from "./support/us-receiving-fixture";
import { csvRequest, csvRow } from "./support/us-receiving-csv-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const outcome = <T>(pending: Promise<T>) =>
  pending.then(
    (value) => ({ value, error: undefined }),
    (error: unknown) => ({ value: undefined, error }),
  );
describe.skipIf(!url)(
  "atomic CSV apply against concurrent commands and revocations",
  { timeout: 15000 },
  () => {
    let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
    let c: Awaited<ReturnType<typeof seedReceivingTenant>>;
    let store: UsReceivingCsvStore;
    beforeAll(async () => {
      if (!url) throw new Error("Missing isolated US database");
      f = await createUsProfileTestDatabase(url);
      store = new UsReceivingCsvStore(f.db);
    }, 60_000);
    afterAll(async () => {
      await f?.close();
    });
    beforeEach(async () => {
      c = await seedReceivingTenant(f.db);
    });
    const preview = () =>
      store.createPreview(c.tenant, c.actor, csvRequest([csvRow(c.product)]), "preview");
    type Preview = Awaited<ReturnType<typeof preview>>;
    const apply = (p: Preview, key: string = randomUUID()) =>
      store.applyPreview(
        c.tenant,
        c.actor,
        p.id,
        { operationKey: key, expectedPreviewDigest: p.previewDigest },
        "apply",
      );
    async function barrier(statement: string, params: unknown[]) {
      const tx = await f.pool.connect();
      try {
        await tx.query("BEGIN");
        const pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing fixture backend identity");
        await tx.query(statement, params);
        return {
          tx,
          pid,
          close: async () => {
            await tx.query("ROLLBACK");
            tx.release();
          },
        };
      } catch (error) {
        await tx.query("ROLLBACK");
        tx.release();
        throw error;
      }
    }
    async function waitFor(pid: number, count = 1) {
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ waiting: number }>(
                "WITH RECURSIVE blocked(pid) AS (SELECT $1::int UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT (count(*)-1)::int AS waiting FROM blocked",
                [pid],
              )
            ).rows[0]?.waiting ?? 0,
          { timeout: 5000 },
        )
        .toBeGreaterThanOrEqual(count);
    }
    async function counts() {
      return (
        await f.pool.query(
          `SELECT
      (SELECT count(*)::int FROM traceability_events WHERE tenant_id=$1) AS events,
      (SELECT count(*)::int FROM receiving_operations WHERE tenant_id=$1) AS operations,
      (SELECT count(*)::int FROM receiving_csv_applications WHERE tenant_id=$1) AS bindings,
      (SELECT count(*)::int FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.csv_applied') AS applied_audits,
      (SELECT count(*)::int FROM tenant_audit_events WHERE organization_id=$1 AND action='traceability.receiving.draft_created') AS draft_audits`,
          [c.tenant],
        )
      ).rows;
    }
    const single = (bindings = 1) => [
      { events: 1, operations: 1, bindings, applied_audits: 1, draft_audits: 1 },
    ];
    const none = [{ events: 0, operations: 0, bindings: 0, applied_audits: 0, draft_audits: 0 }];

    it("restarts an invisible alias-binding race before returning the original result", async () => {
      const origin = await preview(),
        p = await preview(),
        key = randomUUID(),
        original = await apply(origin, key);
      const gate = await barrier("SELECT id FROM receiving_csv_previews WHERE id=$1 FOR UPDATE", [
        p.id,
      ]);
      const first = outcome(apply(p, key));
      let second: ReturnType<typeof first.then> | undefined;
      try {
        await waitFor(gate.pid);
        const waiting = outcome(apply(p));
        second = waiting;
        await waitFor(gate.pid, 2);
        await gate.tx.query("COMMIT");
        expect(await first).toEqual({ value: original, error: undefined });
        expect(await waiting).toEqual({ value: original, error: undefined });
        expect(await counts()).toEqual(single(2));
      } finally {
        await gate.close();
        await first;
        await second;
      }
    });
    it.each(["same-key", "different-key"])(
      "serializes %s contenders on one preview",
      async (mode) => {
        const p = await preview(),
          key = randomUUID();
        const gate = await barrier("SELECT id FROM receiving_csv_previews WHERE id=$1 FOR UPDATE", [
          p.id,
        ]);
        const first = outcome(apply(p, key));
        let second: ReturnType<typeof first.then> | undefined;
        try {
          await waitFor(gate.pid);
          const waiting = outcome(apply(p, mode === "same-key" ? key : randomUUID()));
          second = waiting;
          if (mode === "different-key") await waitFor(gate.pid, 2);
          await gate.tx.query("COMMIT");
          const a = await first,
            b = await waiting;
          expect(a.error).toBeUndefined();
          expect(b.error).toBeUndefined();
          expect(a.value).toBeDefined();
          expect(b.value).toEqual(a.value);
          expect(await counts()).toEqual(single());
        } finally {
          await gate.close();
          await first;
          await second;
        }
      },
    );
    it("serializes one operation across equal-content previews", async () => {
      const a = await preview(),
        b = await preview(),
        key = randomUUID();
      const lock = JSON.stringify(["us-receiving", c.tenant, "receiving.csv.apply", key]);
      const gate = await barrier("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [lock]);
      const first = outcome(apply(a, key)),
        second = outcome(apply(b, key));
      try {
        await waitFor(gate.pid, 2);
        await gate.tx.query("COMMIT");
        const x = await first,
          y = await second;
        expect(x.error).toBeUndefined();
        expect(y.error).toBeUndefined();
        expect(x.value).toBeDefined();
        expect(y.value).toEqual(x.value);
        expect(await counts()).toEqual(single(2));
      } finally {
        await gate.close();
        await first;
        await second;
      }
    });
    it.each([false, true])(
      "reauthorizes after a concurrent role revocation, replay=%s",
      async (replay) => {
        const p = await preview(),
          key = randomUUID();
        if (replay) await apply(p, key);
        const gate = await barrier("UPDATE member SET role='traceability_auditor' WHERE id=$1", [
          c.member,
        ]);
        const pending = outcome(apply(p, key));
        try {
          await waitFor(gate.pid);
          await gate.tx.query("COMMIT");
          expect((await pending).error).toMatchObject({
            status: 403,
            response: { code: "insufficient_permission" },
          });
          expect(await counts()).toEqual(replay ? single() : none);
        } finally {
          await gate.close();
          await pending;
        }
      },
    );
    it("rechecks a product archived while reference resolution waits", async () => {
      const p = await preview();
      const gate = await barrier("UPDATE products SET archived=true WHERE id=$1", [c.product]);
      const pending = outcome(apply(p));
      try {
        await waitFor(gate.pid);
        await gate.tx.query("COMMIT");
        expect((await pending).error).toMatchObject({
          status: 409,
          response: { code: "receiving_csv_preview_stale" },
        });
        expect(await counts()).toEqual(none);
      } finally {
        await gate.close();
        await pending;
      }
    });
    it("does not apply a preview that expires while waiting for reference locks", async () => {
      const p = await preview();
      const gate = await barrier("SELECT id FROM products WHERE id=$1 FOR UPDATE", [c.product]);
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.parse(p.expiresAt) - 1000));
      const pending = outcome(apply(p));
      try {
        await waitFor(gate.pid);
        vi.setSystemTime(new Date(Date.parse(p.expiresAt) + 1000));
        await gate.tx.query("COMMIT");
        expect((await pending).error).toMatchObject({
          status: 409,
          response: { code: "receiving_csv_preview_expired" },
        });
        expect(await counts()).toEqual(none);
      } finally {
        await gate.close();
        await pending;
        vi.useRealTimers();
      }
    });
  },
);
