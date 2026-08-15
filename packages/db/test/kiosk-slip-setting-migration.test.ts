import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/0035_kiosk_slip_qr_setting.sql",
  import.meta.url,
);

describe("kiosk slip QR setting migration", () => {
  it("adds a default-off non-null print setting for existing kiosks", () => {
    expect(existsSync(migrationUrl)).toBe(true);
    const sql = readFileSync(migrationUrl, "utf8");
    expect(sql).toContain(
      'ALTER TABLE "kiosks" ADD COLUMN "print_employee_qr_on_slip" boolean DEFAULT false NOT NULL;',
    );
  });
});
