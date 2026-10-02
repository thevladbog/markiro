import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const frozen = {
  approved_by: "qa-actor",
  approved_at: "2026-10-02T10:00:00Z",
  config_snapshot: { tenant: "Synthetic", provenance: "synthetic_fixture" },
  config_digest: "a".repeat(64),
  pdf_object_key: "private/us-plan/attempt-1.pdf",
  pdf_sha256: "b".repeat(64),
  pdf_byte_size: 1234,
  renderer_version: "plan-pdf-v1",
};
const draft = {
  id: randomUUID(),
  tenant_id: "placeholder",
  version_number: 1,
  status: "draft",
  draft_revision: 1,
  schema_version: 1,
  sections: { procedure: "  Exact Ä  " },
  change_summary: "",
  created_by: "creator-actor",
  created_at: "2026-10-01T09:00:00Z",
  updated_at: "2026-10-01T09:00:00Z",
};
type PlanFields = Partial<
  Record<
    | keyof typeof draft
    | keyof typeof frozen
    | "superseded_by_id"
    | "superseded_at"
    | "retain_through",
    unknown
  >
>;

// pg treats JS arrays as PostgreSQL arrays; encode JSON columns explicitly so
// negative array/scalar fixtures reach JSONB unchanged rather than as '{}'.
function parameter([key, value]: [string, unknown]) {
  return (key === "sections" || key === "config_snapshot") && value !== null
    ? JSON.stringify(value)
    : value;
}

describe.skipIf(!url)("US plan storage migration in owned disposable PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let before: unknown;
  const existingTenant = randomUUID();
  const existingEvent = randomUUID();
  async function existingRows() {
    return Promise.all(
      ["organization", "traceability_profiles", "traceability_events", "receiving_event_roots"].map(
        async (table) =>
          (await fixture.pool.query(`SELECT to_jsonb(t)::text AS exact FROM ${table} t ORDER BY 1`))
            .rows,
      ),
    );
  }
  async function tenant() {
    const id = randomUUID();
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Synthetic',$1,now())",
      [id],
    );
    return id;
  }
  async function insert(tenantId: string, fields: PlanFields = {}) {
    const id = randomUUID();
    const row = { ...draft, tenant_id: tenantId, ...fields, id };
    const entries = Object.entries(row);
    await fixture.pool.query(
      `INSERT INTO traceability_plan_versions(${entries.map(([key]) => key).join()}) VALUES(${entries.map((_, index) => `$${index + 1}`).join()})`,
      entries.map(parameter),
    );
    return id;
  }
  const effective = (tenantId: string, fields: PlanFields = {}) =>
    insert(tenantId, { status: "effective", ...frozen, ...fields });
  const update = (id: string, changes: PlanFields) => {
    const entries = Object.entries(changes);
    return fixture.pool.query(
      `UPDATE traceability_plan_versions SET ${entries.map(([key], index) => `${key}=$${index + 1}`).join()} WHERE id=$${entries.length + 1}`,
      [...entries.map(parameter), id],
    );
  };
  const row = async (id: string) =>
    (
      await fixture.pool.query(
        "SELECT to_jsonb(t) AS value FROM traceability_plan_versions t WHERE id=$1",
        [id],
      )
    ).rows[0]?.value;
  const supersede = (id: string, next: string) =>
    update(id, {
      status: "superseded",
      superseded_by_id: next,
      superseded_at: "2026-10-02T12:00:00Z",
      retain_through: "2028-10-02",
      updated_at: "2026-10-02T12:00:00Z",
    });

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database URL");
    fixture = await createUsProfileTestDatabase(url, 135);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES($1,'Pre-existing synthetic',$1,'2026-09-01T10:00:00Z')",
      [existingTenant],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_profiles(tenant_id,code,baseline_version) VALUES($1,'US_FSMA204_PROCESSOR','fsma204-v1')",
      [existingTenant],
    );
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        "INSERT INTO receiving_event_roots(id,tenant_id,event_number,pending_draft_id) VALUES($1,$2,'REC-26-0001',$1)",
        [existingEvent, existingTenant],
      );
      await tx.query(
        "INSERT INTO traceability_events(id,tenant_id,root_event_id,event_number,time_zone,created_by,updated_by,notes) VALUES($1,$2,$1,'REC-26-0001','America/Chicago','synthetic','synthetic','  Exact Ä  ')",
        [existingEvent, existingTenant],
      );
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    before = await existingRows();
    await migrate(fixture.db, { migrationsFolder: resolve("migrations") });
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves exact pre-existing organization/profile/event/root bytes and applies journal 136", async () => {
    expect(await existingRows()).toEqual(before);
    expect(
      (await fixture.pool.query("SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations"))
        .rows,
    ).toEqual([{ count: 137 }]);
    expect(
      (await fixture.pool.query("SELECT count(*)::int AS count FROM traceability_plan_versions"))
        .rows,
    ).toEqual([{ count: 0 }]);
  });
  it.each(["draft", "effective"])(
    "allows only one %s per tenant, with independent tenant slots",
    async (status) => {
      const own = await tenant();
      const foreign = await tenant();
      const fields = status === "effective" ? { status, ...frozen } : { status };
      await insert(own, fields);
      await insert(foreign, fields);
      await expect(
        insert(own, { ...fields, version_number: 2, change_summary: "Updated procedure" }),
      ).rejects.toMatchObject({ code: "23505", constraint: `traceability_plan_one_${status}_uq` });
    },
  );
  it("allows a draft beside effective but rejects reusing its tenant version number", async () => {
    const own = await tenant();
    await effective(own);
    await expect(insert(own)).rejects.toMatchObject({
      code: "23505",
      constraint: "traceability_plan_tenant_version_uq",
    });
    await insert(own, { version_number: 2 });
  });
  it("rejects cross-tenant supersession lineage", async () => {
    const own = await tenant();
    const first = await effective(own);
    const foreignNext = await effective(await tenant());
    await expect(supersede(first, foreignNext)).rejects.toMatchObject({
      code: "23503",
      constraint: "traceability_plan_superseded_by_fk",
    });
  });
  it.each(Object.keys(frozen) as (keyof typeof frozen)[])(
    "rejects an effective row missing %s",
    async (column) => {
      await expect(effective(await tenant(), { [column]: null })).rejects.toMatchObject({
        code: "23514",
      });
    },
  );
  it.each(Object.keys(frozen) as (keyof typeof frozen)[])(
    "rejects draft with approval field %s",
    async (column) => {
      await expect(insert(await tenant(), { [column]: frozen[column] })).rejects.toMatchObject({
        code: "23514",
      });
    },
  );
  it.each(Object.keys(frozen) as (keyof typeof frozen)[])(
    "rejects a superseded row missing %s",
    async (column) => {
      const own = await tenant();
      const next = await effective(own, { version_number: 2, change_summary: "Changed" });
      await expect(
        insert(own, {
          status: "superseded",
          ...frozen,
          superseded_by_id: next,
          superseded_at: "2026-10-02T12:00:00Z",
          retain_through: "2028-10-02",
          [column]: null,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
  it.each(["superseded_by_id", "superseded_at", "retain_through"] as const)(
    "requires superseded %s and forbids it on draft/effective",
    async (column) => {
      const own = await tenant();
      const next = await effective(own, { version_number: 2, change_summary: "Changed" });
      const fields = {
        status: "superseded",
        ...frozen,
        superseded_by_id: next,
        superseded_at: "2026-10-02T12:00:00Z",
        retain_through: "2028-10-02",
      };
      await expect(insert(own, { ...fields, [column]: null })).rejects.toMatchObject({
        code: "23514",
      });
      await expect(insert(own, { [column]: fields[column] })).rejects.toMatchObject({
        code: "23514",
      });
      await expect(effective(await tenant(), { [column]: fields[column] })).rejects.toMatchObject({
        code: "23514",
      });
    },
  );
  it.each([
    { version_number: 0 },
    { draft_revision: 0 },
    { schema_version: 0 },
    { sections: [] },
    { status: "unknown" },
    { created_by: " " },
  ])("rejects invalid draft shape %j", async (fields) => {
    await expect(insert(await tenant(), fields)).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { config_snapshot: [] },
    { config_digest: "g".repeat(64) },
    { config_digest: "a".repeat(63) },
    { pdf_sha256: "xyz" },
    { pdf_byte_size: 0 },
    { renderer_version: " " },
    { approved_by: " " },
    { pdf_object_key: " " },
    { version_number: 2, change_summary: " \t\n " },
  ])("rejects malformed approval evidence %j", async (fields) => {
    await expect(effective(await tenant(), fields)).rejects.toMatchObject({ code: "23514" });
  });
  const mutations: PlanFields[] = [
    { id: randomUUID() },
    { tenant_id: "foreign" },
    // v3 is unused even when the supersession test also creates its v2 draft;
    // its effective fixture already has a summary, so only version changes.
    { version_number: 3 },
    { created_by: "other" },
    { created_at: "2026-10-01T08:00:00Z" },
    { draft_revision: 2 },
    { schema_version: 2 },
    { sections: { procedure: "Changed" } },
    { change_summary: "Changed" },
    { approved_by: "other" },
    { approved_at: "2026-10-02T11:00:00Z" },
    { config_snapshot: { changed: true } },
    { config_digest: "c".repeat(64) },
    { pdf_object_key: "private/changed.pdf" },
    { pdf_sha256: "c".repeat(64) },
    { pdf_byte_size: 999 },
    { renderer_version: "v2" },
    { updated_at: "2026-10-02T11:00:00Z" },
    { status: "draft" },
    { status: null },
  ];
  it.each(mutations)("rejects standalone effective mutation %j", async (changes) => {
    const id = await effective(
      await tenant(),
      "version_number" in changes ? { change_summary: "Existing approved summary" } : {},
    );
    const before = await row(id);
    await expect(update(id, changes)).rejects.toMatchObject({ code: "23514" });
    expect(await row(id)).toEqual(before);
  });
  it.each(mutations.filter((changes) => !("updated_at" in changes || "status" in changes)))(
    "rejects changed frozen bytes even during supersession %j",
    async (changes) => {
      const own = await tenant();
      const id = await effective(
        own,
        "version_number" in changes ? { change_summary: "Existing approved summary" } : {},
      );
      const next = await insert(own, { version_number: 2 });
      await expect(
        update(id, {
          status: "superseded",
          superseded_by_id: next,
          superseded_at: "2026-10-02T12:00:00Z",
          retain_through: "2028-10-02",
          ...changes,
        }),
      ).rejects.toMatchObject({ code: "23514" });
    },
  );
  it("atomically supersedes effective and approves next draft without changing frozen bytes", async () => {
    const own = await tenant();
    const first = await effective(own);
    const next = await insert(own, { version_number: 2, change_summary: "Updated procedure" });
    const unchanged =
      "to_jsonb(t)-ARRAY['status','superseded_by_id','superseded_at','retain_through','updated_at']";
    const before = (
      await fixture.pool.query(
        `SELECT (${unchanged})::text AS exact FROM traceability_plan_versions t WHERE id=$1`,
        [first],
      )
    ).rows;
    const tx = await fixture.pool.connect();
    try {
      await tx.query("BEGIN");
      await tx.query(
        "UPDATE traceability_plan_versions SET status='superseded',superseded_by_id=$1,superseded_at='2026-10-02T12:00:00Z',retain_through='2028-10-02',updated_at='2026-10-02T12:00:00Z' WHERE id=$2",
        [next, first],
      );
      const entries = Object.entries(frozen);
      await tx.query(
        `UPDATE traceability_plan_versions SET status='effective',${entries.map(([key], index) => `${key}=$${index + 1}`).join()} WHERE id=$${entries.length + 1}`,
        [...entries.map(([, value]) => value), next],
      );
      await tx.query("COMMIT");
    } catch (error) {
      await tx.query("ROLLBACK");
      throw error;
    } finally {
      tx.release();
    }
    expect(
      (
        await fixture.pool.query(
          `SELECT (${unchanged})::text AS exact FROM traceability_plan_versions t WHERE id=$1`,
          [first],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await fixture.pool.query(
          "SELECT id,status,retain_through::text FROM traceability_plan_versions WHERE tenant_id=$1 ORDER BY version_number",
          [own],
        )
      ).rows,
    ).toEqual([
      { id: first, status: "superseded", retain_through: "2028-10-02" },
      { id: next, status: "effective", retain_through: null },
    ]);
    await expect(update(first, { updated_at: "2026-10-02T13:00:00Z" })).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      fixture.pool.query("DELETE FROM traceability_plan_versions WHERE id=$1", [first]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it.each([
    { id: randomUUID() },
    { tenant_id: "foreign" },
    { version_number: 2 },
    { created_by: "other" },
    { created_at: "2026-10-01T08:00:00Z" },
  ])("retains draft identity %j", async (changes) => {
    const id = await insert(await tenant());
    await expect(update(id, changes)).rejects.toMatchObject({ code: "23514" });
  });
  it("permits editing/discarding drafts but rejects effective delete and tenant deletion", async () => {
    const own = await tenant();
    const id = await insert(own);
    await update(id, {
      sections: { procedure: "Updated" },
      draft_revision: 2,
      schema_version: 2,
      change_summary: "Review",
      updated_at: "2026-10-02T11:00:00Z",
    });
    expect(await row(id)).toMatchObject({ sections: { procedure: "Updated" }, draft_revision: 2 });
    await fixture.pool.query("DELETE FROM traceability_plan_versions WHERE id=$1", [id]);
    expect(await row(id)).toBeUndefined();
    const approved = await effective(own);
    await expect(
      fixture.pool.query("DELETE FROM traceability_plan_versions WHERE id=$1", [approved]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("DELETE FROM organization WHERE id=$1", [own]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(await row(approved)).toBeDefined();
  });
});
