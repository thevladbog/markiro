import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL("../migrations/0085_tenant_operational_timezone.sql", import.meta.url);

describe("tenant operational timezone migration", () => {
  it("adds a non-null Moscow-time default without rewriting organization profiles", () => {
    expect(existsSync(migrationUrl)).toBe(true);

    const sql = readFileSync(migrationUrl, "utf8").replace(/\s+/g, " ").trim();
    const statements = sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);
    const expectedAddition =
      'ALTER TABLE "org_profiles" ADD COLUMN "time_zone" text DEFAULT \'Europe/Moscow\' NOT NULL';
    const alterAddColumnOperations = statements.filter((statement) =>
      /^ALTER TABLE (?:"org_profiles"|org_profiles) ADD COLUMN\b/i.test(statement),
    );

    expect(alterAddColumnOperations).toEqual([expectedAddition]);
    expect(statements).toEqual([expectedAddition]);
    expect(sql).not.toMatch(/\bUPDATE\s+(?:"org_profiles"|org_profiles)(?![A-Za-z0-9_])/i);
    expect(sql).not.toMatch(
      /\bDELETE\s+FROM\s+(?:"org_profiles"|org_profiles)(?![A-Za-z0-9_])/i,
    );
  });
});
