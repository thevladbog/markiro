import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
it("adds an atomic owner-scoped branding cache without changing historical migrations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of STATION_MIGRATIONS) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
    }
    const owner = "a".repeat(64),
      snapshot = { schemaVersion: 1, tenantId: "tenant", ownerDigest: owner };
    db.prepare(
      "INSERT INTO station_organization_branding(tenant_id,owner_digest,snapshot_json) VALUES(?,?,?)",
    ).run("tenant", owner, JSON.stringify(snapshot));
    expect(
      db
        .prepare(
          "SELECT snapshot_json FROM station_organization_branding WHERE tenant_id=? AND owner_digest=?",
        )
        .get("tenant", owner),
    ).toEqual({ snapshot_json: JSON.stringify(snapshot) });
    for (const invalid of ["{}", "null", "bad", JSON.stringify({ ...snapshot, tenantId: "other" })])
      expect(() =>
        db.prepare("UPDATE station_organization_branding SET snapshot_json=?").run(invalid),
      ).toThrow();
    expect(db.prepare("SELECT snapshot_json FROM station_organization_branding").get()).toEqual({
      snapshot_json: JSON.stringify(snapshot),
    });
  } finally {
    db.close();
  }
});
