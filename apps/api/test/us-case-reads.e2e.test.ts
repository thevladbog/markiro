import { randomUUID } from "node:crypto";
import { schema } from "@markiro/db";
import { buildSscc } from "@markiro/domain";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsCaseStore } from "../src/modules/traceability/cases/us-case-store";
import { seedCaseBridge } from "./support/us-case-bridge-fixture";
import { createUsProfileTestDatabase } from "./support/us-profile-database";

const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("US case reads", () => {
  let f: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsCaseStore;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(url);
    store = new UsCaseStore(f.db);
  }, 60_000);
  afterAll(async () => {
    await f?.close();
  });

  it("pages 100 synthetic links, counts active independently of history, and preserves unlink/relink", async () => {
    const c = await seedCaseBridge(f);
    await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: c.codes },
      "read-1",
    );
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.list(c.tenant, c.actor, c.lotId, {
        limit: 25,
        history: false,
        ...(cursor ? { cursor } : {}),
      });
      expect(page.activeCount).toBe(100);
      expect(page.rows.length).toBeLessThanOrEqual(25);
      expect(
        page.rows.every(
          (row) => row.provenance === "synthetic_demo" && row.originState === "current",
        ),
      ).toBe(true);
      ids.push(...page.rows.map((row) => row.linkId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
    const first = await store.lookup(c.tenant, c.actor, { sscc: c.codes[0] });
    await store.unlink(
      c.tenant,
      c.actor,
      c.lotId,
      first.activeLink!.linkId,
      { operationKey: randomUUID(), reason: "Replace case link" },
      "read-2",
    );
    await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "read-3",
    );
    const history = await store.list(c.tenant, c.actor, c.lotId, { history: true, limit: 100 });
    expect(history.activeCount).toBe(100);
    expect(history.nextCursor).not.toBeNull();
    if (!history.nextCursor) throw new Error("Missing history cursor");
    const last = await store.list(c.tenant, c.actor, c.lotId, {
      history: true,
      limit: 100,
      cursor: history.nextCursor,
    });
    expect([...history.rows, ...last.rows].filter((row) => row.boxId === first.boxId)).toHaveLength(
      2,
    );
  }, 20_000);

  it("normalizes lookup, denies foreign/unknown cases, and exposes drift without replacing frozen SSCC", async () => {
    const c = await seedCaseBridge(f);
    await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "read-4",
    );
    const code = c.codes[0]!;
    for (const input of [code, `00${code}`, `(00)${code}`, `]C100${code}`]) {
      expect((await store.lookup(c.tenant, c.actor, { sscc: input })).activeLink?.ssccAtLink).toBe(
        code,
      );
    }
    const unlinked = await store.lookup(c.tenant, c.actor, { sscc: c.existingCode });
    expect(unlinked.activeLink).toBeNull();
    const missing = buildSscc(0, "7654321", 999);
    await expect(store.lookup(c.tenant, c.actor, { sscc: missing })).rejects.toMatchObject({
      response: { code: "case_not_found" },
    });
    await expect(store.lookup(randomUUID(), c.actor, { sscc: code })).rejects.toMatchObject({
      response: { code: "insufficient_permission" },
    });
    const changedCode = buildSscc(0, "7654321", 998);
    await f.db
      .update(schema.boxes)
      .set({ sscc: changedCode })
      .where(eq(schema.boxes.id, c.boxes[0]!.id));
    const changed = await store.lookup(c.tenant, c.actor, { sscc: changedCode });
    expect(changed.activeLink).toMatchObject({ ssccAtLink: code, ssccState: "inconsistent" });
    await expect(store.lookup(c.tenant, c.actor, { sscc: code })).rejects.toMatchObject({
      response: { code: "case_not_found" },
    });
    expect((await store.list(c.tenant, c.actor, c.lotId, {})).rows[0]).toMatchObject({
      ssccAtLink: code,
      ssccState: "inconsistent",
    });
  });

  it("retains existing links with an origin gap after void", async () => {
    const c = await seedCaseBridge(f);
    await store.link(
      c.tenant,
      c.actor,
      c.lotId,
      { operationKey: randomUUID(), ssccs: [c.codes[0]] },
      "read-void-link",
    );
    await c.store.void(
      c.tenant,
      c.actor,
      c.original.id,
      { operationKey: randomUUID(), expectedLifecycleVersion: 2, reason: "Void test origin" },
      "read-void",
    );
    const list = await store.list(c.tenant, c.actor, c.lotId, {});
    expect(list).toMatchObject({ activeCount: 1, originState: "gap" });
    expect(list.rows[0]?.originState).toBe("gap");
    expect(
      (await store.lookup(c.tenant, c.actor, { sscc: c.codes[0] })).activeLink?.originState,
    ).toBe("gap");
  });
});
