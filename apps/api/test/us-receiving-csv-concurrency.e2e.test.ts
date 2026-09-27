import { schema } from "@markiro/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  "CSV previews against concurrent authority/reference changes",
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
    async function barrier(statement: string, params: unknown[]) {
      const tx = await f.pool.connect();
      try {
        await tx.query("BEGIN");
        const pid = (await tx.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
          ?.pid;
        if (!pid) throw new Error("Missing fixture connection identity");
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
    async function waitFor(pid: number) {
      await expect
        .poll(
          async () =>
            (
              await f.pool.query<{ waiting: number }>(
                "SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND $1::int=ANY(pg_blocking_pids(pid))",
                [pid],
              )
            ).rows[0]?.waiting ?? 0,
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
    }
    const previews = () =>
      f.db
        .select()
        .from(schema.receivingCsvPreviews)
        .where(eq(schema.receivingCsvPreviews.tenantId, c.tenant));
    const audits = () =>
      f.db
        .select()
        .from(schema.tenantAuditEvents)
        .where(eq(schema.tenantAuditEvents.organizationId, c.tenant));
    it.each(["create", "read"])(
      "does not use revoked membership in a waiting %s",
      async (command) => {
        const saved =
          command === "read"
            ? await store.createPreview(
                c.tenant,
                c.actor,
                csvRequest([csvRow(c.product)]),
                "initial",
              )
            : null;
        const gate = await barrier("UPDATE member SET role='traceability_auditor' WHERE id=$1", [
          c.member,
        ]);
        const pending = outcome(
          saved
            ? store.getPreview(c.tenant, c.actor, saved.id)
            : store.createPreview(c.tenant, c.actor, csvRequest([csvRow(c.product)]), "waiting"),
        );
        try {
          await waitFor(gate.pid);
          await gate.tx.query("COMMIT");
          const result = await pending;
          expect(result.error).toMatchObject({
            status: 403,
            response: { code: "insufficient_permission" },
          });
          expect(result.value).toBeUndefined();
          expect(await previews()).toHaveLength(saved ? 1 : 0);
          expect(await audits()).toHaveLength(saved ? 1 : 0);
        } finally {
          await gate.close();
          await pending;
        }
      },
    );
    it.each(["id", "gtin"])(
      "does not persist a stale applicable proposal when a product is archived (%s)",
      async (selector) => {
        await f.db
          .update(schema.products)
          .set({ gtin14: "00000096385074" })
          .where(eq(schema.products.id, c.product));
        const gate = await barrier("UPDATE products SET archived=true WHERE id=$1", [c.product]);
        const pending = outcome(
          store.createPreview(
            c.tenant,
            c.actor,
            csvRequest([
              selector === "id" ? csvRow(c.product) : csvRow("", { product_gtin: "96385074" }),
            ]),
            "waiting",
          ),
        );
        try {
          await waitFor(gate.pid);
          await gate.tx.query("COMMIT");
          const result = await pending;
          expect(result.error).toBeUndefined();
          expect(result.value).toMatchObject({
            proposedDraft: null,
            previewDigest: null,
            resolution: {
              rows: [
                {
                  rowNumber: 1,
                  productId: null,
                  issues: [
                    { column: selector === "id" ? "product_id" : "product_gtin", code: "inactive" },
                  ],
                },
              ],
            },
          });
          expect(await previews()).toHaveLength(1);
          expect(await audits()).toHaveLength(1);
          expect((await audits())[0]?.after).toMatchObject({
            hasProposal: false,
            previewDigest: null,
          });
          expect(
            (
              await f.pool.query("SELECT id FROM traceability_events WHERE tenant_id=$1", [
                c.tenant,
              ])
            ).rows,
          ).toEqual([]);
        } finally {
          await gate.close();
          await pending;
        }
      },
    );
  },
);
