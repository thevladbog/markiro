import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
it("deduplicates existing branding without altering unknown delivery bytes or historical render facts", () => {
  const start = STATION_MIGRATIONS.findIndex((sql) =>
    sql.includes("CREATE TABLE IF NOT EXISTS pallet_sheet_branding_resources"),
  );
  expect(start).toBeGreaterThan(0);
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const sql of STATION_MIGRATIONS.slice(0, start)) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
    }
    const digest = "b".repeat(64),
      brandingJson = JSON.stringify({
        schemaVersion: 1,
        digest,
        organizationName: "Historical",
        ownerDigest: "a".repeat(64),
        tenantId: "tenant",
        logo: { pixelsBase64: "gA==" },
      });
    const snapshot = {
      schemaVersion: 1,
      facts: { sscc: "saved-sscc" },
      brandingJson,
      digest: "c".repeat(64),
      replayOf: null,
    };
    for (const attempt of ["one", "two"])
      db.prepare(
        "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at,render_snapshot_json) VALUES('owner','pallet','saved-sscc',?,'delivery_unknown','{}',?,'gA==','doc','now',?)",
      ).run(attempt, "a".repeat(64), JSON.stringify(snapshot));
    for (const sql of STATION_MIGRATIONS.slice(start)) db.exec(sql);
    expect(db.prepare("SELECT * FROM pallet_sheet_branding_resources").all()).toEqual([
      { digest, snapshot_json: brandingJson },
    ]);
    for (const row of db
      .prepare(
        "SELECT state,artifact_base64,render_snapshot_json,sheet_branding_digest FROM printer_deliveries",
      )
      .all()) {
      expect(row.state).toBe("delivery_unknown");
      expect(row.artifact_base64).toBe("gA==");
      expect(row.sheet_branding_digest).toBe(digest);
      expect(JSON.parse(String(row.render_snapshot_json))).toEqual({
        ...snapshot,
        brandingJson: undefined,
        brandingResourceDigest: digest,
      });
    }
    expect(() => db.prepare("DELETE FROM pallet_sheet_branding_resources").run()).toThrow();
    expect(() =>
      db.prepare("UPDATE pallet_sheet_branding_resources SET snapshot_json='{}'").run(),
    ).toThrow();
  } finally {
    db.close();
  }
});
