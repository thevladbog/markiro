import { randomUUID } from "node:crypto";
import { receivingFinalizationSnapshotSchema } from "@markiro/platform-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsReceivingStore } from "../src/modules/traceability/receiving/us-receiving-store";
import { createUsProfileTestDatabase } from "./support/us-profile-database";
import { seedCompleteReceiving } from "./support/us-receiving-fixture";

type Snapshot = typeof receivingFinalizationSnapshotSchema._output;
const url = process.env.US_TEST_DATABASE_URL;
describe.skipIf(!url)("receiving frozen-v1 raw transition parity", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let store: UsReceivingStore;
  let c: Awaited<ReturnType<typeof seedCompleteReceiving>>;
  let snapshot: Snapshot;
  let target: string;
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
    const item = c.draft.items[1];
    if (!item) throw new Error("Missing linked fixture item");
    const draft = { ...c.draft, items: [item] };
    const saved = await store.createDraft(
      c.tenant,
      c.actor,
      { operationKey: randomUUID(), draft },
      "create",
    );
    const checked = await store.checkReadiness(c.tenant, c.actor, saved.id, {
      expectedDraftVersion: 1,
    });
    const result = await store.finalize(
      c.tenant,
      c.actor,
      saved.id,
      {
        operationKey: randomUUID(),
        expectedDraftVersion: 1,
        expectedInputDigest: checked.inputDigest,
      },
      "finalize",
    );
    snapshot = result.snapshot;
    target = (
      await store.createDraft(c.tenant, c.actor, { operationKey: randomUUID(), draft }, "target")
    ).id;
  });
  async function transition(value: unknown) {
    const connection = await fixture.pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query(
        "UPDATE receiving_event_roots SET lifecycle_version=2,current_event_id=$2,pending_draft_id=NULL WHERE tenant_id=$1 AND id=$2",
        [c.tenant, target],
      );
      await connection.query(
        "UPDATE traceability_events SET status='finalized', finalized_at=now(), updated_at=now(), finalized_by=$1, updated_by=$1, finalization_snapshot=$2 WHERE tenant_id=$3 AND id=$4",
        [c.actor, value, c.tenant, target],
      );
      await connection.query("COMMIT");
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  }
  async function denied(value: unknown) {
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(false);
    const before = await fixture.pool.query(
      "SELECT to_jsonb(e) AS value FROM traceability_events e WHERE tenant_id=$1 AND id=$2",
      [c.tenant, target],
    );
    await expect(transition(value)).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(e) AS value FROM traceability_events e WHERE tenant_id=$1 AND id=$2",
          [c.tenant, target],
        )
      ).rows,
    ).toEqual(before.rows);
  }
  async function privilegedUrlCorruption(value: unknown) {
    // Owner-approved boundary: SQL checks shape/relationships, not URL/IDNA semantics.
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(false);
    await transition(value);
    const before = await fixture.pool.query(
      "SELECT to_jsonb(e) AS value FROM traceability_events e WHERE tenant_id=$1 AND id=$2",
      [c.tenant, target],
    );
    expect(before.rows[0]?.value.status).toBe("finalized");
    await expect(store.getRecord(c.tenant, c.actor, target)).rejects.toMatchObject({
      status: 503,
      response: { code: "us_database_unavailable" },
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(e) AS value FROM traceability_events e WHERE tenant_id=$1 AND id=$2",
          [c.tenant, target],
        )
      ).rows,
    ).toEqual(before.rows);
  }
  const warning = {
    severity: "warning",
    group: "lines",
    line: 1,
    field: "coverage",
    code: "not_assessed",
    detail: null,
  };
  const shapeCases: [string, (s: Snapshot) => unknown][] = [
    ["unknown root key", (s) => ({ ...s, forged: true })],
    [
      "unknown confirmation key",
      (s) => ({ ...s, confirmation: { ...s.confirmation, forged: true } }),
    ],
    [
      "missing confirmation digest",
      (s) => ({ ...s, confirmation: { ruleVersion: s.confirmation.ruleVersion, warnings: [] } }),
    ],
    [
      "empty warning object",
      (s) => ({ ...s, confirmation: { ...s.confirmation, warnings: [{}] } }),
    ],
    ...[
      ["unknown warning key", { ...warning, forged: true }],
      ["error warning severity", { ...warning, severity: "error" }],
      ["unknown warning group", { ...warning, group: "other" }],
      ["unknown warning field", { ...warning, field: "other" }],
      ["unknown warning code", { ...warning, code: "other" }],
      ["unknown warning detail", { ...warning, detail: "other" }],
      ["array warning group", { ...warning, group: ["lines"] }],
      ["array warning field", { ...warning, field: [] }],
      ["array warning code", { ...warning, code: ["required"] }],
      ["array warning detail", { ...warning, detail: [] }],
      ["header warning with line", { ...warning, group: "header" }],
      ["fractional warning line", { ...warning, line: 1.5 }],
      ["out of range warning line", { ...warning, line: 101 }],
      ["string warning line", { ...warning, line: "1" }],
    ].map(([label, value]): [string, (s: Snapshot) => unknown] => [
      String(label),
      (s) => ({ ...s, confirmation: { ...s.confirmation, warnings: [value] } }),
    ]),
    [
      "too many warnings",
      (s) => ({
        ...s,
        confirmation: { ...s.confirmation, warnings: Array.from({ length: 5001 }, () => warning) },
      }),
    ],
  ];
  it.each(shapeCases)("rejects %s", async (_label, change) => {
    await denied(change(snapshot));
  });
  it.each([
    ["street_address", "streetAddress", null],
    ["street_address", "streetAddress", "   "],
    ["street_address", "streetAddress", "x".repeat(501)],
    ["phone_number", "phoneNumber", "not a phone"],
    ["phone_number", "phoneNumber", "12"],
    ["city", "city", "\t"],
    ["state_or_region", "stateOrRegion", "x".repeat(201)],
    ["zip_or_postal_code", "zipOrPostalCode", "x".repeat(33)],
    ["business_name", "businessName", "😀".repeat(101)],
  ])("rejects incomplete location %s (%s)", async (column, field, value) => {
    await fixture.pool.query(
      `UPDATE traceability_locations SET ${column}=$1 WHERE tenant_id=$2 AND id=$3`,
      [value, c.tenant, c.location],
    );
    const location = {
      ...snapshot.locationDescription,
      ...(field === "streetAddress"
        ? { address: { kind: "street", streetAddress: value } }
        : { [String(field)]: value }),
    };
    await denied({
      ...snapshot,
      locationDescription: location,
      previousSourceDescription: location,
      items: snapshot.items.map((i) => ({ ...i, sourceDescription: location })),
    });
  });
  it.each([null, "1.000000"])("rejects missing coordinate (%s)", async (latitude) => {
    await fixture.pool.query(
      "UPDATE traceability_locations SET address_kind='coordinates',street_address=NULL,latitude=$1,longitude=NULL WHERE tenant_id=$2 AND id=$3",
      [latitude, c.tenant, c.location],
    );
    const location = {
      ...snapshot.locationDescription,
      address: { kind: "coordinates", latitude, longitude: null },
    };
    await denied({
      ...snapshot,
      locationDescription: location,
      previousSourceDescription: location,
      items: snapshot.items.map((i) => ({ ...i, sourceDescription: location })),
    });
  });
  it("rejects FSMA without documents even with reviewed not-covered coverage", async () => {
    await fixture.pool.query(
      "DELETE FROM receiving_event_documents WHERE tenant_id=$1 AND event_id=$2",
      [c.tenant, target],
    );
    await denied({ ...snapshot, documents: [] });
  });
  it("rejects FSMA unknown coverage with a valid document", async () => {
    await fixture.pool.query(
      "DELETE FROM product_traceability_profiles WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    await denied({
      ...snapshot,
      items: snapshot.items.map((i) => ({
        ...i,
        productDescription: { ...i.productDescription, productName: "Synthetic apples" },
        coverage: {
          coverageStatus: "unknown",
          coverageRationale: null,
          ftlCategory: null,
          ftlSourceUrl: null,
          ftlSourceVersion: null,
          reviewedBy: null,
          reviewedAt: null,
        },
      })),
    });
  });
  it.each([
    ["coverage_status", "coverageStatus", "exemption_review_required"],
    ["coverage_status", "coverageStatus", "covered"],
    ["coverage_rationale", "coverageRationale", null],
    ["coverage_rationale", "coverageRationale", "\t"],
    ["ftl_category", "ftlCategory", "x".repeat(201)],
    ["ftl_source_url", "ftlSourceUrl", "\t"],
    ["ftl_source_url", "ftlSourceUrl", "x".repeat(2049)],
    ["ftl_source_version", "ftlSourceVersion", "x".repeat(129)],
  ])("rejects invalid coverage %s (%s)", async (column, field, value) => {
    await fixture.pool.query(
      `UPDATE product_traceability_profiles SET ${column}=$1 WHERE tenant_id=$2 AND product_id=$3`,
      [value, c.tenant, c.product],
    );
    await denied({
      ...snapshot,
      items: snapshot.items.map((i) => ({
        ...i,
        coverage: { ...i.coverage, [String(field)]: value },
      })),
    });
  });
  it.each([
    "https://user:password@example.test/path",
    "not a URL",
    "https://example.test:99999/path",
    "https://[invalid]/path",
    "https://xn--/source",
    "https://xn--a.example/source",
    "https://xn--.test/source",
    "https://\u200d.test/source",
    "https://\u200c.test/source",
    "https://a\u200cb.test/source",
  ])(
    "documents privileged SQL coverage URL corruption and fail-closed GET: %s",
    async (ftlSourceUrl) => {
      await fixture.pool.query(
        "UPDATE product_traceability_profiles SET ftl_source_url=$1 WHERE tenant_id=$2 AND product_id=$3",
        [ftlSourceUrl, c.tenant, c.product],
      );
      await privilegedUrlCorruption({
        ...snapshot,
        items: snapshot.items.map((i) => ({ ...i, coverage: { ...i.coverage, ftlSourceUrl } })),
      });
    },
  );
  it("rejects assessed generic coverage", async () => {
    await fixture.pool.query(
      "UPDATE traceability_profiles SET code='US_GENERIC_LOT_TRACEABILITY' WHERE tenant_id=$1",
      [c.tenant],
    );
    await denied({ ...snapshot, profileCode: "US_GENERIC_LOT_TRACEABILITY" });
  });
  it.each(["00000000000001", "not-a-gtin0000"])(
    "rejects invalid persisted GTIN %s",
    async (gtin) => {
      await fixture.pool.query("UPDATE products SET gtin14=$1 WHERE tenant_id=$2 AND id=$3", [
        gtin,
        c.tenant,
        c.product,
      ]);
      await denied({
        ...snapshot,
        items: snapshot.items.map((i) => ({
          ...i,
          productDescription: { ...i.productDescription, gtin },
        })),
      });
    },
  );
  it.each([
    ["brand_name", "brandName", "x".repeat(201)],
    ["commodity", "commodity", "\t"],
  ])("rejects invalid persisted product %s", async (column, field, value) => {
    await fixture.pool.query(
      `UPDATE product_traceability_profiles SET ${column}=$1 WHERE tenant_id=$2 AND product_id=$3`,
      [value, c.tenant, c.product],
    );
    await denied({
      ...snapshot,
      items: snapshot.items.map((i) => ({
        ...i,
        productDescription: { ...i.productDescription, [String(field)]: value },
      })),
    });
  });
  it("rejects numeric baseline despite equivalent text representation", async () => {
    await fixture.pool.query(
      "UPDATE traceability_profiles SET baseline_version='123' WHERE tenant_id=$1",
      [c.tenant],
    );
    await denied({ ...snapshot, baselineVersion: 123 });
  });
  it("rejects noncanonical TLC whitespace retained by raw DB columns", async () => {
    const lot = randomUUID();
    const tlc = "\u00a0TLC";
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$4,'imported',$5,now(),$6,$6)",
      [lot, c.tenant, c.product, tlc, c.location, c.actor],
    );
    await fixture.pool.query(
      "UPDATE receiving_event_items SET lot_id=$1,tlc=$2 WHERE tenant_id=$3 AND event_id=$4",
      [lot, tlc, c.tenant, target],
    );
    await denied({ ...snapshot, items: snapshot.items.map((i) => ({ ...i, lotId: lot, tlc })) });
  });
  it.each([
    "not a URL",
    "https://user:password@example.test/path",
    "https://example.test:99999/path",
    "https://999.999.999.999/path",
    "https://xn--/source",
    "https://xn--a.example/source",
    "https://xn--.test/source",
    "https://\u200d.test/source",
    "https://\u200c.test/source",
    "https://a\u200cb.test/source",
  ])(
    "documents privileged SQL source URL corruption and fail-closed GET: %s",
    async (referenceValue) => {
      const lot = randomUUID();
      await fixture.pool.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,'REF','imported','web_url',$4,$5,now(),$6,$6)",
        [lot, c.tenant, c.product, referenceValue, c.location, c.actor],
      );
      await fixture.pool.query(
        "UPDATE receiving_event_items SET lot_id=$1,tlc='REF',source_location_id=NULL,source_reference_kind='web_url',source_reference_value=$2,source_reference_location_id=$3 WHERE tenant_id=$4 AND event_id=$5",
        [lot, referenceValue, c.location, c.tenant, target],
      );
      await privilegedUrlCorruption({
        ...snapshot,
        items: snapshot.items.map((i) => ({
          ...i,
          lotId: lot,
          tlc: "REF",
          source: {
            kind: "reference",
            referenceKind: "web_url",
            referenceValue,
            resolvedLocationId: c.location,
          },
        })),
      });
    },
  );
  it("still rejects a raw source snapshot that differs from its stored reference", async () => {
    const item = snapshot.items[0];
    if (!item) throw new Error("Missing line");
    await expect(
      transition({
        ...snapshot,
        items: [
          {
            ...item,
            source: {
              kind: "reference",
              referenceKind: "web_url",
              referenceValue: "https://example.test/forged",
              resolvedLocationId: c.location,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([null, "", "x".repeat(1025)])(
    "retains raw source presence and byte bounds (%s)",
    async (referenceValue) => {
      await expect(
        fixture.pool.query(
          "UPDATE receiving_event_items SET source_location_id=NULL,source_reference_kind='web_url',source_reference_value=$1,source_reference_location_id=$2 WHERE tenant_id=$3 AND event_id=$4",
          [referenceValue, c.location, c.tenant, target],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
  it("rejects blank raw source text at finalization without parsing its URL", async () => {
    const lot = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,'BLANK','imported','web_url','   ',$4,now(),$5,$5)",
      [lot, c.tenant, c.product, c.location, c.actor],
    );
    await fixture.pool.query(
      "UPDATE receiving_event_items SET lot_id=$1,tlc='BLANK',source_location_id=NULL,source_reference_kind='web_url',source_reference_value='   ',source_reference_location_id=$2 WHERE tenant_id=$3 AND event_id=$4",
      [lot, c.location, c.tenant, target],
    );
    await denied({
      ...snapshot,
      items: snapshot.items.map((i) => ({
        ...i,
        lotId: lot,
        tlc: "BLANK",
        source: {
          kind: "reference",
          referenceKind: "web_url",
          referenceValue: "   ",
          resolvedLocationId: c.location,
        },
      })),
    });
  });
  it("accepts a 120-code-point TLC without imposing a UTF-16 identity limit", async () => {
    const lot = randomUUID();
    const tlc = "😀".repeat(120);
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$4,'imported',$5,now(),$6,$6)",
      [lot, c.tenant, c.product, tlc, c.location, c.actor],
    );
    await fixture.pool.query(
      "UPDATE receiving_event_items SET lot_id=$1,tlc=$2 WHERE tenant_id=$3 AND event_id=$4",
      [lot, tlc, c.tenant, target],
    );
    const value = { ...snapshot, items: snapshot.items.map((i) => ({ ...i, lotId: lot, tlc })) };
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(true);
    await transition(value);
  });
  it("accepts complete coordinate and Unicode whitespace phone snapshots", async () => {
    const phoneNumber = "+1\u00a0555\u20280100";
    await fixture.pool.query(
      "UPDATE traceability_locations SET phone_number=$1,address_kind='coordinates',street_address=NULL,latitude=1,longitude=-180 WHERE tenant_id=$2 AND id=$3",
      [phoneNumber, c.tenant, c.location],
    );
    const location = {
      ...snapshot.locationDescription,
      phoneNumber,
      address: { kind: "coordinates", latitude: "1.000000", longitude: "-180.000000" },
    };
    const value = {
      ...snapshot,
      locationDescription: location,
      previousSourceDescription: location,
      items: snapshot.items.map((i) => ({ ...i, sourceDescription: location })),
    };
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(true);
    await transition(value);
  });
  it("accepts the existing builder's ECMAScript-trimmed product description", async () => {
    await fixture.pool.query(
      "UPDATE product_traceability_profiles SET product_name=E'\\tSynthetic apples\\t' WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    expect(receivingFinalizationSnapshotSchema.safeParse(snapshot).success).toBe(true);
    await transition(snapshot);
  });
  it.each([
    "https://[2001:db8::1]:443/path",
    "HTTP://example.test/source",
    "http:example.test/path",
    "https://例子.test/source",
    "https://☃.net/source",
    "https://क्‌ष.test/source",
    "https://xn--11b2ezcs70k.test/source",
  ])("accepts valid coverage URL %s", async (ftlSourceUrl) => {
    await fixture.pool.query(
      "UPDATE product_traceability_profiles SET ftl_source_url=$1,ftl_category='Synthetic category',ftl_source_version='v1',coverage_status='covered' WHERE tenant_id=$2 AND product_id=$3",
      [ftlSourceUrl, c.tenant, c.product],
    );
    const value = {
      ...snapshot,
      items: snapshot.items.map((i) => ({
        ...i,
        coverage: {
          ...i.coverage,
          coverageStatus: "covered",
          ftlCategory: "Synthetic category",
          ftlSourceVersion: "v1",
          ftlSourceUrl,
        },
      })),
    };
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(true);
    await transition(value);
    expect((await store.getRecord(c.tenant, c.actor, target)).status).toBe("finalized");
  });
  it("accepts strict FSMA snapshot and fully shaped warnings", async () => {
    const value = {
      ...snapshot,
      confirmation: {
        ...snapshot.confirmation,
        warnings: [warning, { ...warning, group: "header", line: null }],
      },
    };
    expect(receivingFinalizationSnapshotSchema.safeParse(value).success).toBe(true);
    await transition(value);
    expect((await store.getRecord(c.tenant, c.actor, target)).status).toBe("finalized");
  });
});
