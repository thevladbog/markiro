import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../src/client.js";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
import { migrateThrough } from "./support/us-receiving-lifecycle-fixture.js";
import {
  seed,
  transition,
  type Fixture,
  type Specimen,
} from "./support/us-receiving-snapshot-fixture.js";

const base = process.env.US_TEST_DATABASE_URL;
const coverage = {
  coverageStatus: "covered",
  coverageRationale: "Reviewed raw fixture",
  ftlCategory: "Fresh-cut fruits",
  ftlSourceUrl: "https://www.fda.gov/food/food-traceability-list",
  ftlSourceVersion: "2026",
  reviewedBy: "qa-reviewer",
  reviewedAt: "2026-09-06T09:08:07.123Z",
};
async function dispose(f: Fixture) {
  if (!base) throw new Error("Missing isolated URL");
  const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
    ?.name;
  if (!name || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
    throw new Error("Invalid owned child");
  await f.close();
  const admin = createDb(base);
  try {
    expect(
      (await admin.pool.query("SELECT datname FROM pg_database WHERE datname=$1", [name])).rows,
    ).toEqual([]);
    expect(
      (await admin.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=$1", [name])).rows,
    ).toEqual([]);
    console.info("disposed structured snapshot fixture", name, "catalog/backend absent");
  } finally {
    await admin.pool.end();
  }
}
async function runtime(f: Fixture) {
  if (!base) throw new Error("Missing isolated URL");
  const name = (await f.pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]
    ?.name;
  if (!name || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
    throw new Error("Invalid owned child");
  const url = new URL(base);
  url.pathname = `/${name}`;
  return runRuntimeMigrations({
    databaseUrl: url.toString(),
    migrationsFolder: resolve("migrations"),
    log: () => {},
  });
}

describe.skipIf(!base)("Transformation structured snapshot native enforcement", () => {
  let f: Fixture, c: Specimen, foreign: Specimen;
  let historical: unknown,
    retainedGuards: unknown,
    predecessor = "";
  const historicalRows = async () =>
    (
      await f.pool.query(
        "SELECT to_jsonb(e)::text AS exact FROM traceability_events e WHERE type='transformation' AND finalization_snapshot->>'snapshotVersion'='1' ORDER BY id",
      )
    ).rows;
  const otherGuards = async () =>
    (
      await f.pool.query(
        "SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE '%guard' AND proname<>'transformation_finalization_guard' ORDER BY proname",
      )
    ).rows;
  const inventory = async () =>
    (
      await f.pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
      )
    ).rows[0]?.count;
  const retained = async () =>
    Promise.all(
      [
        "traceability_events",
        "transformation_event_roots",
        "transformation_event_details",
        "transformation_event_inputs",
        "transformation_event_outputs",
        "transformation_event_documents",
        "lot_genealogy_edges",
        "traceability_lots",
        "traceability_locations",
        "product_traceability_profiles",
      ].map(
        async (table) =>
          (await f.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`)).rows,
      ),
    );
  async function tx<T>(action: (client: PoolClient) => Promise<T>) {
    const client = await f.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  function productKdes() {
    return {
      snapshotVersion: 1,
      sourceProductId: c.product,
      productName: "Apple slices",
      brandName: "Fixture brand",
      commodity: "Apples",
      variety: "Gala",
      packagingSize: { value: "12.500", uom: "oz" },
      packagingStyle: "Tray",
      gtin: null,
    };
  }
  async function draft(client: PoolClient, reference = false, coordinates = false, version = 2) {
    const id = randomUUID(),
      out = randomUUID(),
      input = reference ? randomUUID() : c.lot;
    const eventNumber = `TRN-26-${Math.floor(Math.random() * 1e9) + 1000}`;
    if (reference)
      await client.query(
        "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_reference_kind,source_reference_value,source_reference_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$1::uuid::text,'imported','web_url','https://supplier.example.test/Ä?lot=001',$4,now(),'qa-user','qa-user')",
        [input, c.tenant, c.product, c.location],
      );
    await client.query(
      "UPDATE traceability_locations SET address_kind=$2,street_address=$3,latitude=$4,longitude=$5 WHERE id=$1",
      [
        c.location,
        coordinates ? "coordinates" : "street",
        coordinates ? null : "100 Test Way",
        coordinates ? "46.600000" : null,
        coordinates ? "-120.500000" : null,
      ],
    );
    const locationKdes = {
      ...c.snapshot.locationDescription,
      address: coordinates
        ? { kind: "coordinates", latitude: "46.600000", longitude: "-120.500000" }
        : { kind: "street", streetAddress: "100 Test Way" },
    };
    const location = {
      id: c.location,
      description: "Dock",
      ...(version === 2 ? { kdes: locationKdes } : {}),
    };
    const product = {
      id: c.product,
      description: "Apple slices",
      coverage: { ...coverage },
      ...(version === 2 ? { kdes: productKdes() } : {}),
    };
    await client.query(
      "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,time_zone,event_date,location_id,created_by,updated_by) VALUES ($1,$2,$1,'transformation',$3,'America/Chicago','2026-09-07',$4,'qa-user','qa-user')",
      [id, c.tenant, eventNumber, c.location],
    );
    await client.query(
      "INSERT INTO transformation_event_roots(id,tenant_id,event_number,pending_draft_id) SELECT id,tenant_id,event_number,id FROM traceability_events WHERE id=$1",
      [id],
    );
    await client.query(
      "INSERT INTO transformation_event_details(tenant_id,event_id,reason) VALUES ($1,$2,'repacking')",
      [c.tenant, id],
    );
    await client.query(
      "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) VALUES ($1,$2,1,'ftl_lot',$3,'500.000','lb')",
      [c.tenant, id, input],
    );
    await client.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,source_location_id,source_locked_at,created_by,updated_by) VALUES ($1,$2,$3,$1::uuid::text,'transformation',$4,now(),'qa-user','qa-user')",
      [out, c.tenant, c.product, c.location],
    );
    await client.query(
      "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id,product_id,tlc,quantity,unit_of_measure) VALUES ($1,$2,1,$3,$4,$3::uuid::text,'100','case')",
      [c.tenant, id, out, c.product],
    );
    await client.query(
      "INSERT INTO transformation_event_documents(tenant_id,event_id,document_id,position) VALUES ($1,$2,$3,1)",
      [c.tenant, id, c.document],
    );
    await client.query(
      "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) VALUES ($1,$2,$3,$4)",
      [c.tenant, id, input, out],
    );
    return {
      id,
      out,
      snapshot: {
        snapshotVersion: version,
        eventId: id,
        eventNumber,
        revision: 1,
        eventDate: "2026-09-07",
        timeZone: "America/Chicago",
        processor: structuredClone(location),
        reason: "repacking",
        reasonNote: null,
        notes: null,
        inputs: [
          {
            kind: "ftl_lot",
            lineNo: 1,
            lotId: input,
            product: structuredClone(product),
            tlc: reference ? input : "=Case/Ä-001",
            source: reference
              ? {
                  ...structuredClone(location),
                  kind: "reference",
                  referenceKind: "web_url",
                  referenceValue: "https://supplier.example.test/Ä?lot=001",
                }
              : { ...structuredClone(location), kind: "location" },
            quantity: "500.000",
            unitOfMeasure: "lb",
          },
        ],
        outputs: [
          {
            lineNo: 1,
            lotId: out,
            product: structuredClone(product),
            tlc: out,
            source: { ...structuredClone(location), kind: "location" },
            quantity: "100",
            unitOfMeasure: "case",
          },
        ],
        documents: [{ id: c.document, type: "bol", number: "0001" }],
        finalizedBy: "qa-user",
        finalizedAt: "2026-09-07T10:00:00.000Z",
      },
    };
  }
  async function finalize(client: PoolClient, id: string, snapshot: unknown) {
    await client.query(
      "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$2 WHERE id=$1",
      [id, snapshot],
    );
    await client.query(
      "UPDATE transformation_event_roots SET current_event_id=id,pending_draft_id=NULL,lifecycle_version=2 WHERE id=$1",
      [id],
    );
  }
  beforeAll(async () => {
    if (!base) throw new Error("Missing isolated URL");
    f = await createUsProfileTestDatabase(base, 124);
    c = await seed(f);
    foreign = await seed(f);
    await transition(f, c);
    await transition(f, foreign);
    await migrateThrough(f, 144);
    await f.pool.query(
      "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,brand_name,commodity,variety,packaging_size_value,packaging_size_uom,packaging_style,coverage_status,coverage_rationale,ftl_category,ftl_source_url,ftl_source_version,reviewed_by,reviewed_at) VALUES ($1,$2,' Apple slices ',' Fixture brand ','Apples','Gala','12.500','oz',' Tray ','covered',$3,$4,$5,$6,$7,$8)",
      [
        c.tenant,
        c.product,
        coverage.coverageRationale,
        coverage.ftlCategory,
        coverage.ftlSourceUrl,
        coverage.ftlSourceVersion,
        coverage.reviewedBy,
        coverage.reviewedAt,
      ],
    );
    await tx(async (client) => {
      const d = await draft(client, false, false, 1);
      await finalize(client, d.id, d.snapshot);
    });
    historical = await historicalRows();
    retainedGuards = await otherGuards();
    predecessor =
      (
        await f.pool.query<{ definition: string }>(
          "SELECT pg_get_functiondef('transformation_finalization_guard()'::regprocedure) AS definition",
        )
      ).rows[0]?.definition ?? "";
    expect(predecessor.length).toBeGreaterThan(1000);
    expect(await inventory()).toBe(145);
    await runtime(f);
  }, 60_000);
  afterAll(async () => {
    if (f) await dispose(f);
  });
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])("commits valid V2 reference=%s coordinates=%s", async (reference, coordinates) => {
    const d = await tx(async (client) => {
      const value = await draft(client, reference, coordinates);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    expect(
      (
        await f.pool.query(
          "SELECT status,finalization_snapshot FROM traceability_events WHERE id=$1",
          [d.id],
        )
      ).rows,
    ).toEqual([{ status: "finalized", finalization_snapshot: d.snapshot }]);
  });
  const mutations: {
    name: string;
    path: string[];
    value?: unknown;
    remove?: boolean;
    version?: number;
  }[] = [
    { name: "missing version", path: ["snapshotVersion"], remove: true },
    { name: "null version", path: ["snapshotVersion"], value: null },
    { name: "unknown version", path: ["snapshotVersion"], value: 3 },
    { name: "string version", path: ["snapshotVersion"], value: "2" },
    { name: "extra top-level key", path: ["extra"], value: true },
    { name: "unexpected original predecessor", path: ["previousRevisionId"], value: randomUUID() },
    ...["processor", "inputs.0.source", "outputs.0.source"].flatMap((scope) => [
      { name: `${scope} missing kdes`, path: [...scope.split("."), "kdes"], remove: true },
      { name: `${scope} null kdes`, path: [...scope.split("."), "kdes"], value: null },
      { name: `${scope} extra field`, path: [...scope.split("."), "extra"], value: true },
      ...[
        "schemaVersion",
        "locationId",
        "partyId",
        "businessName",
        "phoneNumber",
        "city",
        "stateOrRegion",
        "zipOrPostalCode",
        "countryCode",
        "countryDisplay",
        "address",
      ].map((field) => ({
        name: `${scope} forged ${field}`,
        path: [...scope.split("."), "kdes", field],
        value: "forged",
      })),
      { name: `${scope} extra KDE`, path: [...scope.split("."), "kdes", "extra"], value: true },
    ]),
    ...["inputs", "outputs"].flatMap((side) => [
      { name: `${side} missing product kdes`, path: [side, "0", "product", "kdes"], remove: true },
      { name: `${side} null product kdes`, path: [side, "0", "product", "kdes"], value: null },
      { name: `${side} extra product field`, path: [side, "0", "product", "extra"], value: true },
      { name: `${side} extra line field`, path: [side, "0", "extra"], value: true },
      ...[
        "snapshotVersion",
        "sourceProductId",
        "productName",
        "brandName",
        "commodity",
        "variety",
        "packagingSize",
        "packagingStyle",
        "gtin",
      ].map((field) => ({
        name: `${side} forged ${field}`,
        path: [side, "0", "product", "kdes", field],
        value: "forged",
      })),
      {
        name: `${side} extra product KDE`,
        path: [side, "0", "product", "kdes", "extra"],
        value: true,
      },
    ]),
    {
      name: "V1 source kdes remains forbidden",
      path: ["inputs", "0", "source", "kdes"],
      value: {},
      version: 1,
    },
    {
      name: "V1 source extra remains forbidden",
      path: ["inputs", "0", "source", "extra"],
      value: true,
      version: 1,
    },
    ...[1, 2].flatMap((version) => [
      { name: `V${version} wrong header date`, path: ["eventDate"], value: "2026-09-08", version },
      { name: `V${version} wrong revision`, path: ["revision"], value: 2, version },
      {
        name: `V${version} wrong input quantity`,
        path: ["inputs", "0", "quantity"],
        value: "499",
        version,
      },
      {
        name: `V${version} wrong output identity`,
        path: ["outputs", "0", "lotId"],
        value: randomUUID(),
        version,
      },
      {
        name: `V${version} wrong output processor description`,
        path: ["outputs", "0", "source", "description"],
        value: "Other processor",
        version,
      },
      {
        name: `V${version} wrong reviewed coverage`,
        path: ["inputs", "0", "product", "coverage", "reviewedBy"],
        value: "invented-reviewer",
        version,
      },
      {
        name: `V${version} missing reviewed coverage`,
        path: ["outputs", "0", "product", "coverage"],
        remove: true,
        version,
      },
      {
        name: `V${version} wrong reference identity`,
        path: ["inputs", "0", "source", "referenceValue"],
        value: "https://other.example.test",
        version,
      },
      {
        name: `V${version} wrong document`,
        path: ["documents", "0", "number"],
        value: "9999",
        version,
      },
    ]),
  ];
  it.each(mutations)(
    "rejects $name at commit and rolls back every native write",
    async (mutation) => {
      const before = await retained();
      let reachedCommit = false;
      await expect(
        tx(async (client) => {
          const d = await draft(client, true, false, mutation.version ?? 2);
          let target: object = d.snapshot;
          for (const key of mutation.path.slice(0, -1)) {
            const child: unknown = Reflect.get(target, key);
            if (!child || typeof child !== "object")
              throw new Error(`Invalid mutation path ${mutation.name}`);
            target = child;
          }
          const key = mutation.path.at(-1);
          if (!key) throw new Error("Empty mutation path");
          if (mutation.remove) Reflect.deleteProperty(target, key);
          else Reflect.set(target, key, mutation.value);
          await finalize(client, d.id, d.snapshot);
          reachedCommit = true;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(reachedCommit).toBe(true);
      expect(await retained()).toEqual(before);
    },
  );
  it.each(["product", "processor", "source"])(
    "rejects foreign-tenant %s facts with full rollback",
    async (field) => {
      const before = await retained();
      let reachedCommit = false;
      await expect(
        tx(async (client) => {
          const d = await draft(client);
          if (field === "product")
            Reflect.set(
              d.snapshot.inputs[0]?.product ?? {},
              "kdes",
              foreign.snapshot.items[0]?.productDescription,
            );
          else
            Reflect.set(
              field === "processor" ? d.snapshot.processor : (d.snapshot.inputs[0]?.source ?? {}),
              "kdes",
              foreign.snapshot.locationDescription,
            );
          await finalize(client, d.id, d.snapshot);
          reachedCommit = true;
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(reachedCommit).toBe(true);
      expect(await retained()).toEqual(before);
    },
  );
  it.each(["product", "location"])(
    "rejects %s facts changed before finalization",
    async (field) => {
      const before = await retained();
      await expect(
        tx(async (client) => {
          const d = await draft(client);
          if (field === "product")
            await client.query(
              "UPDATE product_traceability_profiles SET brand_name='Later brand' WHERE tenant_id=$1 AND product_id=$2",
              [c.tenant, c.product],
            );
          else
            await client.query(
              "UPDATE traceability_locations SET city='Later city' WHERE tenant_id=$1 AND id=$2",
              [c.tenant, c.location],
            );
          await finalize(client, d.id, d.snapshot);
        }),
      ).rejects.toMatchObject({ code: "23514" });
      expect(await retained()).toEqual(before);
    },
  );
  it("reuses exact native product and location matchers and fails closed for SQL/JSON null", async () => {
    await tx(async (client) => {
      const d = await draft(client, true, true);
      const product = d.snapshot.inputs[0]?.product;
      const source = d.snapshot.inputs[0]?.source;
      expect(
        (
          await client.query(
            "SELECT receiving_product_snapshot_matches(jsonb_build_object('productDescription',$1::jsonb->'kdes','coverage',$1::jsonb->'coverage'),$3,$4) AS product, transformation_product_v2_matches($1,$3,$4) AS wrapped_product, receiving_location_snapshot_matches($2::jsonb->'kdes',$3,$5) AS location, transformation_location_v2_matches($2::jsonb-ARRAY['kind','referenceKind','referenceValue'],$3,$5) AS wrapped_location",
            [product, source, c.tenant, c.product, c.location],
          )
        ).rows,
      ).toEqual([{ product: true, wrapped_product: true, location: true, wrapped_location: true }]);
      for (const value of [null, "null", "{}"]) {
        expect(
          (
            await client.query(
              "SELECT transformation_product_v2_matches($1::jsonb,$2,$3) AS product, transformation_location_v2_matches($1::jsonb,$2,$4) AS location, transformation_snapshot_v2_matches($1::jsonb,$2,$5,$4,NULL) AS snapshot",
              [value, c.tenant, c.product, c.location, d.id],
            )
          ).rows,
        ).toEqual([{ product: false, location: false, snapshot: false }]);
      }
      await finalize(client, d.id, d.snapshot);
    });
  });
  it("accepts a native non-FTL input with its own structured product and direct source", async () => {
    await tx(async (client) => {
      const d = await draft(client);
      const productId = randomUUID();
      const nonFtlCoverage = {
        ...coverage,
        coverageStatus: "not_covered",
        ftlCategory: null,
        ftlSourceUrl: null,
        ftlSourceVersion: null,
      };
      await client.query("INSERT INTO products(id,tenant_id,name) VALUES ($1,$2,'Salt')", [
        productId,
        c.tenant,
      ]);
      await client.query(
        "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,coverage_status,coverage_rationale,reviewed_by,reviewed_at) VALUES ($1,$2,'Salt','not_covered',$3,$4,$5)",
        [c.tenant, productId, coverage.coverageRationale, coverage.reviewedBy, coverage.reviewedAt],
      );
      await client.query(
        "UPDATE transformation_event_inputs SET kind='non_ftl',lot_id=NULL,product_id=$2,source_location_id=$3,reference='NON-FTL-001' WHERE event_id=$1",
        [d.id, productId, c.location],
      );
      await client.query("DELETE FROM lot_genealogy_edges WHERE event_id=$1", [d.id]);
      const input = d.snapshot.inputs[0];
      if (!input) throw new Error("Missing input");
      Reflect.deleteProperty(input, "lotId");
      Reflect.deleteProperty(input, "tlc");
      Reflect.set(input, "kind", "non_ftl");
      Reflect.set(input, "reference", "NON-FTL-001");
      Reflect.set(input, "product", {
        id: productId,
        description: "Salt",
        coverage: nonFtlCoverage,
        kdes: {
          snapshotVersion: 1,
          sourceProductId: productId,
          productName: "Salt",
          brandName: null,
          commodity: null,
          variety: null,
          packagingSize: null,
          packagingStyle: null,
          gtin: null,
        },
      });
      await finalize(client, d.id, d.snapshot);
    });
  });
  it.each(["valid", "missing-predecessor", "wrong-predecessor"])(
    "enforces V1-to-V2 revision identity: %s",
    async (mode) => {
      const before = await retained();
      const action = tx(async (client) => {
        const original = await draft(client, false, false, 1);
        await finalize(client, original.id, original.snapshot);
        const id = randomUUID();
        await client.query(
          "INSERT INTO traceability_events(id,tenant_id,root_event_id,type,event_number,revision,previous_revision_id,amendment_reason,time_zone,event_date,location_id,created_by,updated_by) SELECT $1,tenant_id,id,type,event_number,2,id,'Correct inputs',time_zone,event_date,location_id,created_by,updated_by FROM traceability_events WHERE id=$2",
          [id, original.id],
        );
        await client.query(
          "UPDATE transformation_event_roots SET pending_draft_id=$1,next_revision=3,lifecycle_version=lifecycle_version+1 WHERE id=$2",
          [id, original.id],
        );
        await client.query(
          "INSERT INTO transformation_event_details(tenant_id,event_id,reason) SELECT tenant_id,$1,reason FROM transformation_event_details WHERE event_id=$2",
          [id, original.id],
        );
        await client.query(
          "INSERT INTO transformation_event_inputs(tenant_id,event_id,line_no,kind,lot_id,quantity,unit_of_measure) SELECT tenant_id,$1,line_no,kind,lot_id,quantity,unit_of_measure FROM transformation_event_inputs WHERE event_id=$2",
          [id, original.id],
        );
        await client.query(
          "INSERT INTO transformation_event_outputs(tenant_id,event_id,line_no,lot_id,product_id,tlc,quantity,unit_of_measure) SELECT tenant_id,$1,line_no,lot_id,product_id,tlc,quantity,unit_of_measure FROM transformation_event_outputs WHERE event_id=$2",
          [id, original.id],
        );
        await client.query(
          "INSERT INTO transformation_event_documents(tenant_id,event_id,document_id,position) SELECT tenant_id,$1,document_id,position FROM transformation_event_documents WHERE event_id=$2",
          [id, original.id],
        );
        await client.query(
          "INSERT INTO lot_genealogy_edges(tenant_id,event_id,input_lot_id,output_lot_id) SELECT tenant_id,$1,input_lot_id,output_lot_id FROM lot_genealogy_edges WHERE event_id=$2",
          [id, original.id],
        );
        const snapshot = {
          ...structuredClone(original.snapshot),
          snapshotVersion: 2,
          eventId: id,
          revision: 2,
          ...(mode === "missing-predecessor"
            ? {}
            : { previousRevisionId: mode === "wrong-predecessor" ? randomUUID() : original.id }),
        };
        Reflect.set(snapshot.processor, "kdes", c.snapshot.locationDescription);
        for (const line of [...snapshot.inputs, ...snapshot.outputs]) {
          Reflect.set(line.product, "kdes", productKdes());
          Reflect.set(line.source, "kdes", c.snapshot.locationDescription);
        }
        await client.query(
          "UPDATE traceability_events SET status='amended',superseded_by_event_id=$1,superseded_at='2026-09-07T10:00:00Z',superseded_by='qa-user' WHERE id=$2",
          [id, original.id],
        );
        await client.query(
          "UPDATE traceability_events SET status='finalized',finalized_at='2026-09-07T10:00:00Z',updated_at='2026-09-07T10:00:00Z',finalized_by='qa-user',updated_by='qa-user',finalization_snapshot=$2 WHERE id=$1",
          [id, snapshot],
        );
        await client.query(
          "UPDATE transformation_event_roots SET current_event_id=$1,pending_draft_id=NULL,lifecycle_version=lifecycle_version+1 WHERE id=$2",
          [id, original.id],
        );
        return { original, id, snapshot };
      });
      if (mode !== "valid") {
        await expect(action).rejects.toMatchObject({ code: "23514" });
        expect(await retained()).toEqual(before);
      } else {
        const result = await action;
        expect(
          (
            await f.pool.query(
              "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
              [result.original.id],
            )
          ).rows,
        ).toEqual([{ finalization_snapshot: result.original.snapshot }]);
        expect(
          (
            await f.pool.query(
              "SELECT finalization_snapshot FROM traceability_events WHERE id=$1",
              [result.id],
            )
          ).rows,
        ).toEqual([{ finalization_snapshot: result.snapshot }]);
        // Include this additional immutable V1 predecessor in the later replay assertion.
        historical = await historicalRows();
      }
    },
  );
  it("upgrades exactly one migration, preserves predecessor guards and V1 bytes, and replays as no-op", async () => {
    expect(await inventory()).toBe(146);
    expect(await historicalRows()).toEqual(historical);
    expect(await otherGuards()).toEqual(retainedGuards);
    const expected = predecessor
      .replace(
        "(s->'snapshotVersion') IS DISTINCT FROM '1'::jsonb",
        "((s->'snapshotVersion') IS DISTINCT FROM '1'::jsonb AND (s->'snapshotVersion') IS DISTINCT FROM '2'::jsonb)",
      )
      .replace(
        "(j->'source')-'description' ORDER BY n",
        "(CASE WHEN s->'snapshotVersion'='2'::jsonb THEN (j->'source')-'kdes' ELSE j->'source' END)-'description' ORDER BY n",
      )
      .replace(
        "  RETURN NULL;\nEXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN",
        "  IF s->'snapshotVersion'='2'::jsonb AND\n    transformation_snapshot_v2_matches(s,e.tenant_id,e.id,e.location_id,e.previous_revision_id) IS DISTINCT FROM true\n  THEN RAISE EXCEPTION 'Transformation structured snapshot mismatch' USING ERRCODE='23514'; END IF;\n  RETURN NULL;\nEXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN",
      );
    expect(
      (
        await f.pool.query(
          "SELECT pg_get_functiondef('transformation_finalization_guard()'::regprocedure) AS definition",
        )
      ).rows,
    ).toEqual([{ definition: expected }]);
    const before = await retained();
    const result = await runtime(f);
    expect(result.packaged.at(-1)).toBe("0145_us_transformation_structured_snapshot");
    expect(await inventory()).toBe(146);
    expect(await retained()).toEqual(before);
    expect(await otherGuards()).toEqual(retainedGuards);
  });
  it("continues accepting V1 and never rehydrates historical V1/V2 facts", async () => {
    const d = await tx(async (client) => {
      const value = await draft(client, false, false, 1);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    const v2 = await tx(async (client) => {
      const value = await draft(client);
      await finalize(client, value.id, value.snapshot);
      return value;
    });
    await f.pool.query(
      "UPDATE product_traceability_profiles SET brand_name='Changed after finalization' WHERE tenant_id=$1 AND product_id=$2",
      [c.tenant, c.product],
    );
    await f.pool.query(
      "UPDATE traceability_locations SET business_name='Changed after finalization' WHERE tenant_id=$1 AND id=$2",
      [c.tenant, c.location],
    );
    await runtime(f);
    for (const value of [d, v2]) {
      expect(
        (
          await f.pool.query("SELECT finalization_snapshot FROM traceability_events WHERE id=$1", [
            value.id,
          ])
        ).rows,
      ).toEqual([{ finalization_snapshot: value.snapshot }]);
      await expect(
        f.pool.query("UPDATE traceability_events SET finalization_snapshot='{}' WHERE id=$1", [
          value.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    }
  });
  it("installs all 146 migrations on a fresh owned database and repeats as no-op", async () => {
    if (!base) throw new Error("Missing isolated URL");
    const fresh = await createUsProfileTestDatabase(base);
    try {
      expect(
        (await fresh.pool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"))
          .rows,
      ).toEqual([{ count: 146 }]);
      await runtime(fresh);
      expect(
        (await fresh.pool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"))
          .rows,
      ).toEqual([{ count: 146 }]);
    } finally {
      await dispose(fresh);
    }
  }, 60_000);
  it("rejects missing or duplicate predecessor anchors atomically", async () => {
    if (!base) throw new Error("Missing isolated URL");
    const prefix = await createUsProfileTestDatabase(base, 144);
    try {
      const definition = (
        await prefix.pool.query<{ definition: string }>(
          "SELECT pg_get_functiondef('transformation_finalization_guard()'::regprocedure) AS definition",
        )
      ).rows[0]?.definition;
      if (!definition) throw new Error("Missing predecessor");
      for (const anchor of [
        "(s->'snapshotVersion') IS DISTINCT FROM '1'::jsonb",
        "(j->'source')-'description' ORDER BY n",
        "IF NEW.status<>'finalized' THEN RETURN NULL; END IF;",
        "(s->'revision') IS DISTINCT FROM to_jsonb(e.revision)",
        "  RETURN NULL;\nEXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN",
      ]) {
        for (const duplicate of [false, true]) {
          const drifted = duplicate
            ? definition.replace("BEGIN", `BEGIN\n  /* ${anchor} */`)
            : definition.replace(anchor, anchor.replace(/\S /, "$& "));
          expect(drifted).not.toBe(definition);
          await prefix.pool.query(drifted);
          const installed = (
            await prefix.pool.query<{ definition: string; digest: string }>(
              "SELECT pg_get_functiondef(oid) AS definition,md5(prosrc) AS digest FROM pg_proc WHERE oid='transformation_finalization_guard()'::regprocedure",
            )
          ).rows[0];
          expect(installed?.definition).toBe(drifted);
          expect(installed?.digest).not.toBe("e1cf68af3638b778cc4cb4dd9b393d33");
          expect(installed?.definition.split(anchor).length).toBe(duplicate ? 3 : 1);
          expect(
            (
              await prefix.pool.query(
                "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
              )
            ).rows,
          ).toEqual([{ count: 145 }]);
          await expect(runtime(prefix)).rejects.toThrow(/Transformation V2 predecessor/);
          expect(
            (
              await prefix.pool.query(
                "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
              )
            ).rows,
          ).toEqual([{ count: 145 }]);
          expect(
            (
              await prefix.pool.query(
                "SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('transformation_product_v2_matches','transformation_location_v2_matches','transformation_snapshot_v2_matches')",
              )
            ).rows,
          ).toEqual([]);
        }
      }
      await prefix.pool.query(
        definition.replace(
          "BEGIN",
          "BEGIN\n  -- unexpected predecessor drift outside replacement anchors",
        ),
      );
      await expect(runtime(prefix)).rejects.toThrow(
        "Transformation V2 predecessor body shape changed",
      );
      await prefix.pool.query(definition);
      await runtime(prefix);
      expect(
        (await prefix.pool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"))
          .rows,
      ).toEqual([{ count: 146 }]);
    } finally {
      await dispose(prefix);
    }
  }, 60_000);
});
