import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

import {
  time,
  reason,
  receipt,
  seed,
  firstItem,
  transition,
  type Fixture,
  type Path,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const url = process.env.US_TEST_DATABASE_URL;
async function state(fixture: Fixture) {
  return (
    await fixture.pool.query(`SELECT e.id,to_jsonb(e) AS event,
    (SELECT jsonb_agg(to_jsonb(i)-'exempt_receipt' ORDER BY i.line_no) FROM receiving_event_items i WHERE i.tenant_id=e.tenant_id AND i.event_id=e.id) AS items,
    (SELECT jsonb_agg(to_jsonb(o) ORDER BY o.operation_key) FROM receiving_operations o WHERE o.tenant_id=e.tenant_id AND o.event_id=e.id) AS operations
    FROM traceability_events e ORDER BY e.id`)
  ).rows;
}
describe.skipIf(!url)("additive receiving exemption migration", () => {
  let fixture: Fixture;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, 122);
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  it("preserves complete rows and original operation bytes for legacy exempt/ordinary drafts and finalized v1", async () => {
    const ordinary = await seed(fixture, "ordinary", 1);
    const exempt = await seed(fixture, "preserved", 1);
    await fixture.pool.query(
      "UPDATE receiving_event_items SET tlc=NULL,quantity=NULL,source_location_id=NULL WHERE event_id=$1",
      [exempt.id],
    );
    const finalized = await seed(fixture, "ordinary", 1);
    await transition(fixture, finalized);
    for (const c of [ordinary, exempt, finalized])
      await fixture.pool.query(
        "INSERT INTO receiving_operations(tenant_id,command,operation_key,input_digest,event_id,result) VALUES ($1,'receiving.create',$2,$3,$4,$5)",
        [
          c.tenant,
          randomUUID(),
          "b".repeat(64),
          c.id,
          { legacy: "  exact original  ", quantity: "500.000", snapshotVersion: 1 },
        ],
      );
    const before = await state(fixture);
    const bytes = await fixture.pool.query(
      "SELECT operation_key,result::text FROM receiving_operations ORDER BY operation_key",
    );
    expect(() => readFileSync("migrations/0123_us_receiving_exemption.sql", "utf8")).not.toThrow();
    await fixture.pool.query(readFileSync("migrations/0123_us_receiving_exemption.sql", "utf8"));
    expect(await state(fixture)).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT operation_key,result::text FROM receiving_operations ORDER BY operation_key",
        )
      ).rows,
    ).toEqual(bytes.rows);
    expect(
      (await fixture.pool.query("SELECT exempt_receipt FROM receiving_event_items")).rows,
    ).toEqual([{ exempt_receipt: null }, { exempt_receipt: null }, { exempt_receipt: null }]);
  });
  it.each([
    null,
    [],
    true,
    1,
    "text",
    {},
    { evidenceUrl: null, tlcHandling: null },
    { ...receipt, extra: true },
    { ...receipt, evidenceUrl: 1 },
    { ...receipt, evidenceUrl: false },
    { ...receipt, evidenceUrl: "" },
    { ...receipt, evidenceUrl: "x".repeat(1025) },
    { ...receipt, evidenceUrl: "é".repeat(513) },
    { ...receipt, tlcHandling: [] },
    { ...receipt, tlcHandling: "invented" },
    { ...receipt, proposedTlc: 42 },
    { ...receipt, proposedTlc: "" },
    { ...receipt, proposedTlc: "x".repeat(121) },
    { ...receipt, proposedTlc: " bad " },
    { ...receipt, proposedTlc: "bad\ncode" },
  ])("rejects malformed present draft object %#", async (value) => {
    const c = await seed(fixture);
    await expect(
      fixture.pool.query(
        "UPDATE receiving_event_items SET exempt_receipt=$1::jsonb WHERE event_id=$2",
        [JSON.stringify(value), c.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    null,
    { evidenceUrl: null, tlcHandling: null, proposedTlc: null },
    receipt,
    { ...receipt, proposedTlc: "😀".repeat(120) },
    { ...receipt, evidenceUrl: "x".repeat(1024) },
  ])("retains nullable/incomplete/inactive exemption input %#", async (value) => {
    const c = await seed(fixture);
    await fixture.pool.query(
      "UPDATE receiving_event_items SET exempt_receipt=$1::jsonb WHERE event_id=$2",
      [value === null ? null : JSON.stringify(value), c.id],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT exempt_receipt,exempt_supplier FROM receiving_event_items WHERE event_id=$1",
          [c.id],
        )
      ).rows,
    ).toEqual([{ exempt_receipt: value, exempt_supplier: false }]);
  });
  it.each<Path>(["ordinary", "preserved", "assigned"])(
    "finalizes the exact %s v2 path without rewriting received TLC",
    async (path) => {
      const c = await seed(fixture, path);
      await transition(fixture, c);
      expect(
        (
          await fixture.pool.query(
            "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
            [c.id],
          )
        ).rows,
      ).toEqual([{ finalization_snapshot: c.snapshot }]);
      expect(
        (
          await fixture.pool.query(
            "SELECT i.tlc,l.tlc AS effective,l.assignment_basis FROM receiving_event_items i JOIN traceability_lots l ON l.tenant_id=i.tenant_id AND l.id=i.lot_id WHERE i.event_id=$1",
            [c.id],
          )
        ).rows,
      ).toEqual([
        {
          tlc: path === "assigned" ? null : "=Case/Ä-001",
          effective: "=Case/Ä-001",
          assignment_basis: path === "assigned" ? "exempt_supplier_receipt" : "imported",
        },
      ]);
    },
  );
  it.each<Path>(["preserved", "assigned"])(
    "rejects a sub-millisecond finalizer/review mismatch for %s",
    async (path) => {
      const c = await seed(fixture, path);
      const before = await state(fixture);
      await expect(
        transition(fixture, c, c.snapshot, "2026-09-07T10:00:00.000123Z"),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await state(fixture)).toEqual(before);
    },
  );
  it.each<Path>(["preserved", "assigned"])(
    "retains an exact nonzero-millisecond review instant for %s",
    async (path) => {
      const c = await seed(fixture, path);
      const finalizedAt = "2026-09-07T10:00:00.123Z";
      const snapshot = {
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            receiptBasis: { ...firstItem(c).receiptBasis, reviewedAt: finalizedAt },
          },
        ],
      };
      await transition(fixture, c, snapshot, finalizedAt);
      expect(
        (
          await fixture.pool.query(
            "SELECT finalized_at=$1::timestamptz AS exact,finalization_snapshot FROM traceability_events WHERE id=$2",
            [finalizedAt, c.id],
          )
        ).rows,
      ).toEqual([{ exact: true, finalization_snapshot: snapshot }]);
    },
  );
  it("retains the original v1 unrestricted finalization timestamp", async () => {
    const c = await seed(fixture, "ordinary", 1);
    const finalizedAt = "2026-09-07T10:00:00.000123Z";
    await transition(fixture, c, c.snapshot, finalizedAt);
    expect(
      (
        await fixture.pool.query(
          "SELECT finalized_at=$1::timestamptz AS exact FROM traceability_events WHERE id=$2",
          [finalizedAt, c.id],
        )
      ).rows,
    ).toEqual([{ exact: true }]);
  });
  it.each([null, "not a timestamp", "2026-02-30T10:00:00.000Z", "2026-09-07T25:00:00.000Z"])(
    "rejects malformed review timestamp %# without persisting a transition",
    async (reviewedAt) => {
      const c = await seed(fixture, "assigned");
      const before = await state(fixture);
      const snapshot = {
        ...c.snapshot,
        items: [{ ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, reviewedAt } }],
      };
      await expect(transition(fixture, c, snapshot)).rejects.toMatchObject({ code: "23514" });
      expect(await state(fixture)).toEqual(before);
    },
  );
  const mutations: [string, (c: Specimen) => unknown][] = [
    ["root key", (c) => ({ ...c.snapshot, extra: true })],
    ["unknown version", (c) => ({ ...c.snapshot, snapshotVersion: 3 })],
    [
      "confirmation key",
      (c) => ({ ...c.snapshot, confirmation: { ...c.snapshot.confirmation, extra: true } }),
    ],
    [
      "missing reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: {
          ruleVersion: "receiving-readiness-v3",
          inputDigest: "a".repeat(64),
          warnings: [],
        },
      }),
    ],
    [
      "empty reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: [] },
      }),
    ],
    [
      "extra reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: [1, 2] },
      }),
    ],
    [
      "duplicate reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: [1, 1] },
      }),
    ],
    [
      "null reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: null },
      }),
    ],
    [
      "string reviews",
      (c) => ({
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: ["1"] },
      }),
    ],
    ["null basis", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), receiptBasis: null }] })],
    [
      "missing basis",
      (c) => {
        const { receiptBasis: ignored, ...item } = firstItem(c);
        void ignored;
        return { ...c.snapshot, items: [item] };
      },
    ],
    [
      "basis kind",
      (c) => ({
        ...c.snapshot,
        items: [
          { ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, kind: "ordinary" } },
        ],
      }),
    ],
    [
      "basis extra key",
      (c) => ({
        ...c.snapshot,
        items: [{ ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, extra: true } }],
      }),
    ],
    [
      "reviewer",
      (c) => ({
        ...c.snapshot,
        items: [
          { ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, reviewedBy: "forged" } },
        ],
      }),
    ],
    [
      "review time",
      (c) => ({
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            receiptBasis: { ...firstItem(c).receiptBasis, reviewedAt: "2026-09-07T10:00:01.000Z" },
          },
        ],
      }),
    ],
    [
      "reason",
      (c) => ({
        ...c.snapshot,
        items: [
          { ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, reason: "forged" } },
        ],
      }),
    ],
    [
      "evidence",
      (c) => ({
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            receiptBasis: { ...firstItem(c).receiptBasis, evidenceUrl: "https://other.test" },
          },
        ],
      }),
    ],
    [
      "received TLC",
      (c) => ({
        ...c.snapshot,
        items: [
          { ...firstItem(c), receiptBasis: { ...firstItem(c).receiptBasis, receivedTlc: "old" } },
        ],
      }),
    ],
    ["TLC", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), tlc: "forged" }] })],
    ["quantity", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), quantity: "500" }] })],
    ["unit", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), unitOfMeasure: "kg" }] })],
    ["product", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), productId: randomUUID() }] })],
    ["lot", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), lotId: randomUUID() }] })],
    [
      "source",
      (c) => ({
        ...c.snapshot,
        items: [{ ...firstItem(c), source: { kind: "location", locationId: randomUUID() } }],
      }),
    ],
    [
      "description",
      (c) => ({
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            sourceDescription: { ...firstItem(c).sourceDescription, phoneNumber: null },
          },
        ],
      }),
    ],
    [
      "product description",
      (c) => ({
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            productDescription: { ...firstItem(c).productDescription, productName: "forged" },
          },
        ],
      }),
    ],
    [
      "coverage",
      (c) => ({
        ...c.snapshot,
        items: [{ ...firstItem(c), coverage: { ...firstItem(c).coverage, reviewedBy: "qa-user" } }],
      }),
    ],
    ["document", (c) => ({ ...c.snapshot, documents: [] })],
    ["item extra key", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), extra: true }] })],
    ["item order", (c) => ({ ...c.snapshot, items: [{ ...firstItem(c), lineNo: 2 }] })],
  ];
  it.each(mutations)("denies v2 corrupted %s atomically", async (_label, change) => {
    const c = await seed(fixture, "assigned");
    const before = await state(fixture);
    await expect(transition(fixture, c, change(c))).rejects.toMatchObject({ code: "23514" });
    expect(await state(fixture)).toEqual(before);
  });
  it.each([
    ["ordinary flag", "exempt_supplier=false"],
    ["null saved reason", "exempt_reason=NULL"],
    ["changed saved reason", "exempt_reason='different'"],
    ["null saved evidence", "exempt_receipt=jsonb_set(exempt_receipt,'{evidenceUrl}','null')"],
    [
      "changed saved evidence",
      `exempt_receipt=jsonb_set(exempt_receipt,'{evidenceUrl}','"https://different.test"')`,
    ],
    ["missing mode", "exempt_receipt=jsonb_set(exempt_receipt,'{tlcHandling}','null')"],
    [
      "wrong mode",
      `exempt_receipt=jsonb_set(exempt_receipt,'{tlcHandling}','"preserve_existing"')`,
    ],
    ["missing proposal", "exempt_receipt=jsonb_set(exempt_receipt,'{proposedTlc}','null')"],
    ["wrong proposal", `exempt_receipt=jsonb_set(exempt_receipt,'{proposedTlc}','"OTHER"')`],
    ["received TLC already present", "tlc='=Case/Ä-001'"],
    ["linked mode", "lot_link_mode='link_existing'"],
    ["missing saved object", "exempt_receipt=NULL"],
  ])("denies v2 inconsistent saved %s", async (_label, set) => {
    const c = await seed(fixture, "assigned");
    await fixture.pool.query(`UPDATE receiving_event_items SET ${set} WHERE event_id=$1`, [c.id]);
    await expect(transition(fixture, c)).rejects.toMatchObject({ code: "23514" });
  });
  it("denies an own-assigned snapshot backed by an imported lot", async () => {
    const c = await seed(fixture, "assigned", 2, "imported");
    await expect(transition(fixture, c)).rejects.toMatchObject({ code: "23514" });
  });
  it.each<Path>(["ordinary", "preserved"])(
    "retains actual linked-lot assignment basis for %s",
    async (path) => {
      const c = await seed(fixture, path, 2, "transformation");
      await fixture.pool.query(
        "UPDATE receiving_event_items SET lot_link_mode='link_existing' WHERE event_id=$1",
        [c.id],
      );
      c.snapshot.items = [{ ...firstItem(c), lotLinkMode: "link_existing" }];
      await transition(fixture, c);
      expect(
        (
          await fixture.pool.query("SELECT assignment_basis FROM traceability_lots WHERE id=$1", [
            c.lot,
          ])
        ).rows,
      ).toEqual([{ assignment_basis: "transformation" }]);
    },
  );
  it.each<Path>(["ordinary", "preserved"])("denies a new non-imported lot for %s", async (path) => {
    const c = await seed(fixture, path, 2, "transformation");
    await expect(transition(fixture, c)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    ["proposal retained", `exempt_receipt=jsonb_set(exempt_receipt,'{proposedTlc}','"PROPOSAL"')`],
    [
      "wrong mode",
      `exempt_receipt=jsonb_set(exempt_receipt,'{tlcHandling}','"assign_if_missing"')`,
    ],
    ["inactive flag", "exempt_supplier=false"],
    ["received TLC absent", "tlc=NULL"],
  ])("denies preserved path with %s", async (_label, set) => {
    const c = await seed(fixture, "preserved");
    await fixture.pool.query(`UPDATE receiving_event_items SET ${set} WHERE event_id=$1`, [c.id]);
    await expect(transition(fixture, c)).rejects.toMatchObject({ code: "23514" });
  });
  it("denies own assignment at a different physical receiving site", async () => {
    const c = await seed(fixture, "assigned");
    const location = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code) SELECT $1,tenant_id,party_id,'Other dock',business_name,phone_number,street_address,city,state_or_region,zip_or_postal_code,country_code FROM traceability_locations WHERE id=$2",
      [location, c.location],
    );
    await fixture.pool.query("UPDATE traceability_events SET location_id=$1 WHERE id=$2", [
      location,
      c.id,
    ]);
    await expect(
      transition(fixture, c, {
        ...c.snapshot,
        locationId: location,
        locationDescription: { ...c.snapshot.locationDescription, locationId: location },
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each<Path>(["preserved", "assigned"])(
    "retains reference source only on the preserved path: %s",
    async (path) => {
      const c = await seed(fixture, path);
      const lot = randomUUID();
      const sourceUrl = "https://supplier.example.test/Original/Ä";
      await fixture.pool.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,'=Case/Ä-001',$4,'web_url',$5,$6,$7,'qa-user','qa-user')",
        [
          lot,
          c.tenant,
          c.product,
          path === "assigned" ? "exempt_supplier_receipt" : "imported",
          sourceUrl,
          c.location,
          time,
        ],
      );
      await fixture.pool.query(
        "UPDATE receiving_event_items SET lot_id=$1,source_location_id=NULL,source_reference_kind='web_url',source_reference_value=$2,source_reference_location_id=$3 WHERE event_id=$4",
        [lot, sourceUrl, c.location, c.id],
      );
      const snapshot = {
        ...c.snapshot,
        items: [
          {
            ...firstItem(c),
            lotId: lot,
            source: {
              kind: "reference",
              referenceKind: "web_url",
              referenceValue: sourceUrl,
              resolvedLocationId: c.location,
            },
          },
        ],
      };
      if (path === "assigned")
        await expect(transition(fixture, c, snapshot)).rejects.toMatchObject({ code: "23514" });
      else {
        await transition(fixture, c, snapshot);
        expect(
          (
            await fixture.pool.query(
              "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
              [c.id],
            )
          ).rows,
        ).toEqual([{ finalization_snapshot: snapshot }]);
      }
    },
  );
  it("denies own-assigned lots beyond initial revision", async () => {
    const c = await seed(fixture, "assigned");
    await fixture.pool.query("UPDATE traceability_lots SET revision=2 WHERE id=$1", [c.lot]);
    await expect(transition(fixture, c)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    "not a URL",
    "https://user:password@example.test/",
    "https://xn--/",
    "https://例え.テスト/Ä",
  ])("retains the approved SQL structural-only evidence boundary: %s", async (evidence) => {
    const c = await seed(fixture, "assigned");
    await fixture.pool.query(
      "UPDATE receiving_event_items SET exempt_receipt=jsonb_set(exempt_receipt,'{evidenceUrl}',$1::jsonb) WHERE event_id=$2",
      [JSON.stringify(evidence), c.id],
    );
    c.snapshot.items = [
      {
        ...firstItem(c),
        receiptBasis: {
          kind: "exempt_assigned_tlc",
          reason,
          evidenceUrl: evidence,
          reviewedBy: "qa-user",
          reviewedAt: time,
          receivedTlc: null,
        },
      },
    ];
    await transition(fixture, c);
    expect(
      (
        await fixture.pool.query(
          "SELECT finalization_snapshot->'items'->0->'receiptBasis'->>'evidenceUrl' AS evidence FROM traceability_events WHERE id=$1",
          [c.id],
        )
      ).rows,
    ).toEqual([{ evidence }]);
  });
  it("binds mixed exempt/ordinary lines and document ordering to the saved receipt", async () => {
    const c = await seed(fixture, "assigned");
    const lot = randomUUID(),
      document = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,'ORDINARY','imported',$4,$5,'qa-user','qa-user')",
      [lot, c.tenant, c.product, c.location, time],
    );
    await fixture.pool.query(
      "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,product_id,lot_id,lot_link_mode,tlc,quantity,unit_of_measure,source_location_id,exempt_supplier) VALUES ($1,$2,2,$3,$4,'create_on_finalize','ORDINARY','1.250','kg',$5,false)",
      [c.tenant, c.id, c.product, lot, c.location],
    );
    await fixture.pool.query(
      "INSERT INTO reference_documents(id,tenant_id,type,number,created_by) VALUES ($1,$2,'po','0002','qa-user')",
      [document, c.tenant],
    );
    await fixture.pool.query("INSERT INTO receiving_event_documents VALUES ($1,$2,$3,2)", [
      c.tenant,
      c.id,
      document,
    ]);
    c.snapshot.items.push({
      ...firstItem(c),
      lineNo: 2,
      lotId: lot,
      tlc: "ORDINARY",
      quantity: "1.250",
      unitOfMeasure: "kg",
      receiptBasis: { kind: "ordinary" },
    });
    c.snapshot.documents.push({
      document: {
        snapshotVersion: 1,
        documentId: document,
        type: "po",
        typeOtherLabel: null,
        number: "0002",
        partyId: null,
        issuedOn: null,
        notes: null,
      },
      issuer: null,
    });
    await expect(
      transition(fixture, c, { ...c.snapshot, documents: [...c.snapshot.documents].reverse() }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      transition(fixture, c, {
        ...c.snapshot,
        confirmation: { ...c.snapshot.confirmation, reviewedExemptLines: [1, 2] },
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await transition(fixture, c);
    expect(
      (
        await fixture.pool.query(
          "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
          [c.id],
        )
      ).rows,
    ).toEqual([{ finalization_snapshot: c.snapshot }]);
  });
  it.each(["INSERT", "UPDATE", "DELETE", "MOVE"] as const)(
    "keeps finalized v2 document %s immutable",
    async (operation) => {
      const c = await seed(fixture, "assigned");
      await transition(fixture, c);
      const other = randomUUID();
      await fixture.pool.query(
        "INSERT INTO traceability_events(id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,$2,'REC-26-0002','America/Chicago','qa-user','qa-user')",
        [other, c.tenant],
      );
      const statement =
        operation === "INSERT"
          ? "INSERT INTO receiving_event_documents SELECT tenant_id,event_id,document_id,2 FROM receiving_event_documents WHERE event_id=$1"
          : operation === "UPDATE"
            ? "UPDATE receiving_event_documents SET position=2 WHERE event_id=$1"
            : operation === "DELETE"
              ? "DELETE FROM receiving_event_documents WHERE event_id=$1"
              : `UPDATE receiving_event_documents SET event_id='${other}' WHERE event_id=$1`;
      await expect(fixture.pool.query(statement, [c.id])).rejects.toMatchObject({ code: "23514" });
    },
  );
  it.each(["INSERT", "UPDATE", "DELETE", "MOVE"] as const)(
    "keeps finalized v2 item %s immutable",
    async (operation) => {
      const c = await seed(fixture, "assigned");
      await transition(fixture, c);
      const other = randomUUID();
      await fixture.pool.query(
        "INSERT INTO traceability_events(id,tenant_id,event_number,time_zone,created_by,updated_by) VALUES ($1,$2,'REC-26-0002','America/Chicago','qa-user','qa-user')",
        [other, c.tenant],
      );
      const statement =
        operation === "INSERT"
          ? "INSERT INTO receiving_event_items(tenant_id,event_id,line_no,lot_link_mode,exempt_supplier) SELECT tenant_id,event_id,2,'create_on_finalize',false FROM receiving_event_items WHERE event_id=$1"
          : operation === "UPDATE"
            ? "UPDATE receiving_event_items SET exempt_reason='changed' WHERE event_id=$1"
            : operation === "DELETE"
              ? "DELETE FROM receiving_event_items WHERE event_id=$1"
              : `UPDATE receiving_event_items SET event_id='${other}' WHERE event_id=$1`;
      await expect(fixture.pool.query(statement, [c.id])).rejects.toMatchObject({ code: "23514" });
      await expect(
        fixture.pool.query("UPDATE traceability_events SET notes='changed' WHERE id=$1", [c.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        fixture.pool.query("DELETE FROM traceability_events WHERE id=$1", [c.id]),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
});
