import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../migrations/0044_landing_demo_email.sql", import.meta.url),
);

describe("landing demo mail migration", () => {
  it("adds the nullable public request scope and its delivery indexes without rewriting payload data", async () => {
    const migration = (await readFile(migrationPath, "utf8")).replace(/\s+/g, " ");

    expect(migration).toContain(
      'ALTER TABLE "email_deliveries" ADD COLUMN "public_request_id" uuid;',
    );
    expect(migration).toContain(
      'ALTER TABLE "email_deliveries" DROP CONSTRAINT "email_deliveries_scope_xor";',
    );
    expect(migration).toMatch(
      /ALTER TABLE "email_deliveries" ADD CONSTRAINT "email_deliveries_scope_xor" CHECK \(num_nonnulls\((?:"email_deliveries"\.)?"tenant_id", (?:"email_deliveries"\.)?"user_id", (?:"email_deliveries"\.)?"platform_user_id", (?:"email_deliveries"\.)?"public_request_id"\) = 1\);/,
    );
    expect(migration).toMatch(
      /CREATE INDEX "email_deliveries_public_request_status_idx" ON "email_deliveries"(?: USING btree)? \("public_request_id","status"\);/,
    );
    expect(migration).toMatch(
      /CREATE UNIQUE INDEX "email_deliveries_public_request_kind_uq" ON "email_deliveries"(?: USING btree)? \("public_request_id","kind"\) WHERE (?:"email_deliveries"\.)?"public_request_id" IS NOT NULL;/i,
    );
    expect(migration).not.toMatch(
      /ALTER TABLE "email_deliveries" ADD COLUMN "public_request_id" uuid[^;]* NOT NULL;/,
    );
    expect(migration).not.toMatch(/"(?:recipient|encrypted_payload|payload_nonce|payload_tag)"/);
  });
});
