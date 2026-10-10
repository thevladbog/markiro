import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { STATION_MIGRATIONS } from "../src/sqlite/migrations.js";
it("adds a nullable bounded snapshot without altering a historical delivery", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of STATION_MIGRATIONS.slice(0, -1)) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
    }
    db.prepare(
      "INSERT INTO printer_deliveries(scope,purpose,job_id,attempt_id,state,profile_json,artifact_digest,artifact_base64,document_name,updated_at) VALUES('owner','pallet','sscc','old','delivery_unknown','{}',?,'gA==','doc','now')",
    ).run("a".repeat(64));
    db.exec(STATION_MIGRATIONS.at(-1)!);
    expect(
      db.prepare("SELECT artifact_base64,render_snapshot_json FROM printer_deliveries").get(),
    ).toEqual({ artifact_base64: "gA==", render_snapshot_json: null });
    for (const invalid of ["bad", " ".repeat(700001)])
      expect(() =>
        db.prepare("UPDATE printer_deliveries SET render_snapshot_json=?").run(invalid),
      ).toThrow();
    db.prepare("UPDATE printer_deliveries SET render_snapshot_json=?").run('{"schemaVersion":1}');
    expect(db.prepare("SELECT artifact_base64 FROM printer_deliveries").get()).toEqual({
      artifact_base64: "gA==",
    });
  } finally {
    db.close();
  }
});
