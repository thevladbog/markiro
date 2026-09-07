import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

const url = process.env.US_TEST_DATABASE_URL;
const invalidUrls = [
  "not a URL",
  "https://user:password@example.test/path",
  "https://example.test:99999/path",
  "https://[invalid]/path",
  "https://999.999.999.999/path",
  "https://xn--/source",
  "https://xn--a.example/source",
  "https://xn--.test/source",
  "https://\u200d.test/source",
  "https://\u200c.test/source",
  "https://a\u200cb.test/source",
] as const;
const validUrls = [
  "https://例子.test/source",
  "https://☃.net/source",
  "https://क्‌ष.test/source",
  "https://xn--11b2ezcs70k.test/source",
  "https://[2001:db8::1]:443/path",
  "HTTP://example.test/source",
] as const;
describe.skipIf(!url)("Receiving server-authoritative URL/IDNA boundary", () => {
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
  async function effects() {
    return (
      await fixture.pool.query(
        "SELECT (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.id) FROM traceability_events e WHERE e.tenant_id=$1) AS headers, (SELECT jsonb_agg(to_jsonb(i) ORDER BY i.event_id,i.line_no) FROM receiving_event_items i WHERE i.tenant_id=$1) AS items, (SELECT jsonb_agg(to_jsonb(d) ORDER BY d.event_id,d.position) FROM receiving_event_documents d WHERE d.tenant_id=$1) AS documents, (SELECT jsonb_agg(to_jsonb(c) ORDER BY c.year) FROM receiving_counters c WHERE c.tenant_id=$1) AS counters, (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.operation_key) FROM receiving_operations r WHERE r.tenant_id=$1) AS receipts, (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM tenant_audit_events a WHERE a.organization_id=$1) AS audit, (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM traceability_lots l WHERE l.tenant_id=$1) AS lots",
        [c.tenant],
      )
    ).rows;
  }
  it.each(
    invalidUrls.flatMap(
      (value) =>
        [
          ["coverage", value],
          ["source", value],
        ] as const,
    ),
  )("rejects corrupted %s URL before effects: %s", async (kind, value) => {
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
    if (kind === "coverage")
      await fixture.pool.query(
        "UPDATE product_traceability_profiles SET ftl_source_url=$1 WHERE tenant_id=$2 AND product_id=$3",
        [value, c.tenant, c.product],
      );
    else
      await fixture.pool.query(
        "UPDATE receiving_event_items SET source_location_id=NULL,source_reference_kind='web_url',source_reference_value=$1,source_reference_location_id=$2 WHERE tenant_id=$3 AND event_id=$4 AND line_no=1",
        [value, c.location, c.tenant, saved.id],
      );
    const before = await effects();
    // Privileged raw reference corruption fails at the existing strict persisted-data boundary.
    await expect(
      store.checkReadiness(c.tenant, c.actor, saved.id, { expectedDraftVersion: 1 }),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    await expect(
      store.finalize(
        c.tenant,
        c.actor,
        saved.id,
        {
          operationKey: randomUUID(),
          expectedDraftVersion: 1,
          expectedInputDigest: checked.inputDigest,
        },
        "invalid-url",
      ),
    ).rejects.toMatchObject({ status: 503, response: { code: "us_database_unavailable" } });
    expect(await effects()).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT source_locked_at FROM traceability_lots WHERE tenant_id=$1 AND id=$2",
          [c.tenant, c.lot],
        )
      ).rows,
    ).toEqual([{ source_locked_at: null }]);
  });
  it.each(
    validUrls.flatMap(
      (value) =>
        [
          ["coverage", value],
          ["source", value],
        ] as const,
    ),
  )("finalizes real server %s with lossless international URL: %s", async (kind, value) => {
    const first = c.draft.items[0];
    if (!first) throw new Error("Missing new-lot line");
    if (kind === "coverage")
      await fixture.pool.query(
        "UPDATE product_traceability_profiles SET ftl_source_url=$1,ftl_category='Synthetic category',ftl_source_version='v1',coverage_status='covered' WHERE tenant_id=$2 AND product_id=$3",
        [value, c.tenant, c.product],
      );
    const draft =
      kind === "source"
        ? {
            ...c.draft,
            items: [
              {
                ...first,
                source: {
                  kind: "reference" as const,
                  referenceKind: "web_url" as const,
                  referenceValue: value,
                  resolvedLocationId: c.location,
                },
              },
              ...c.draft.items.slice(1),
            ],
          }
        : c.draft;
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
    const command = {
      operationKey: randomUUID(),
      expectedDraftVersion: 1,
      expectedInputDigest: checked.inputDigest,
    };
    const result = await store.finalize(c.tenant, c.actor, saved.id, command, "valid-url");
    expect(result.status).toBe("finalized");
    expect(result.snapshot.items[0]).toMatchObject(
      kind === "source"
        ? { source: { referenceValue: value } }
        : { coverage: { ftlSourceUrl: value } },
    );
    expect(await store.getRecord(c.tenant, c.actor, saved.id)).toEqual(result);
    expect(await store.finalize(c.tenant, c.actor, saved.id, command, "replay")).toEqual(result);
  });
  it("does not install an approximate SQL URL parser", async () => {
    expect(
      (
        await fixture.pool.query(
          "SELECT proname FROM pg_proc WHERE proname IN ('receiving_web_url_v1_valid','receiving_ipv4_v1_valid')",
        )
      ).rows,
    ).toEqual([]);
  });
});
