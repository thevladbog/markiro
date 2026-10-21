import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Migration 0197: landing leads, their journal and the notification outbox (spec §15.2).
describe.skipIf(!databaseUrl)("landing leads migration", () => {
  const databaseName = `markiro_landing_leads_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  async function lead(email: string | null, overrides: Record<string, unknown> = {}) {
    const values = {
      id: randomUUID(),
      email,
      company: "ООО «Пивоварня»",
      locale: "ru",
      first_source_path: "/skachat/",
      ...overrides,
    };
    const columns = Object.keys(values);
    await pool.query(
      `INSERT INTO landing_leads (${columns.join(",")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(",")})`,
      Object.values(values),
    );
    return values.id;
  }

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
  });

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.end();
  });

  it("keeps one lead per normalized e-mail and any number of anonymized ones", async () => {
    await lead("buyer@example.invalid");
    await expect(lead(" Buyer@Example.invalid ")).rejects.toMatchObject({ code: "23505" });
    await lead(null, { anonymized_at: new Date() });
    await lead(null, { anonymized_at: new Date() });
  });

  it("rejects contacts on an anonymized lead and a lead without e-mail that is not anonymized", async () => {
    await expect(lead("kept@example.invalid", { anonymized_at: new Date() })).rejects.toMatchObject(
      { code: "23514" },
    );
    await expect(lead(null)).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a lead without a company (invoice form) but not an empty company", async () => {
    await lead(`${randomUUID()}@example.invalid`, { company: null, inn: "7707083893" });
    await expect(lead(`${randomUUID()}@example.invalid`, { company: "" })).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("checks status, lines bucket, locale and note length", async () => {
    for (const overrides of [
      { status: "paid" },
      { lines_bucket: "5" },
      { locale: "de" },
      { owner_note: "x".repeat(2001) },
    ]) {
      await expect(lead(`${randomUUID()}@example.invalid`, overrides)).rejects.toMatchObject({
        code: "23514",
      });
    }
    await lead(`${randomUUID()}@example.invalid`, {
      status: "invoice_sent",
      lines_bucket: "2-3",
      owner_note: "x".repeat(2000),
    });
  });

  it("makes a public request id idempotent and cascades events with the lead", async () => {
    const leadId = await lead(`${randomUUID()}@example.invalid`);
    const requestId = randomUUID();
    const insert = () =>
      pool.query(
        "INSERT INTO landing_lead_events (id, lead_id, kind, payload, public_request_id) VALUES ($1,$2,'download','{}',$3)",
        [randomUUID(), leadId, requestId],
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        "INSERT INTO landing_lead_events (id, lead_id, kind, payload) VALUES ($1,$2,'unknown','{}')",
        [randomUUID(), leadId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query("DELETE FROM landing_leads WHERE id = $1", [leadId]);
    const events = await pool.query("SELECT 1 FROM landing_lead_events WHERE lead_id = $1", [
      leadId,
    ]);
    expect(events.rowCount).toBe(0);
  });

  it("keeps one digest per day and ties every other notification to a lead", async () => {
    const digest = () =>
      pool.query(
        "INSERT INTO lead_notifications (id, kind, digest_date, payload) VALUES ($1,'daily_digest','2026-10-21','{}')",
        [randomUUID()],
      );
    await digest();
    await expect(digest()).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query("INSERT INTO lead_notifications (id, kind) VALUES ($1,'new_lead')", [
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const leadId = await lead(`${randomUUID()}@example.invalid`);
    const row = await pool.query(
      "INSERT INTO lead_notifications (id, lead_id, kind) VALUES ($1,$2,'new_lead') RETURNING status, attempts",
      [randomUUID(), leadId],
    );
    expect(row.rows).toEqual([{ status: "pending", attempts: 0 }]);
  });
});
