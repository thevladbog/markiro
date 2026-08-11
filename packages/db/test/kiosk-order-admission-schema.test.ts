import { getTableName } from "drizzle-orm";
import { getTableConfig, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.js";

describe("durable kiosk order admission schema", () => {
  it("binds a hashed server attestation to tenant, kiosk, sequence, subscription and content", () => {
    const table = (schema as unknown as Record<string, unknown>).kioskOrderAdmissions as
      AnyPgTable | undefined;

    expect(table, "schema.kioskOrderAdmissions is missing").toBeDefined();
    const config = getTableConfig(table!);
    expect(getTableName(table!)).toBe("kiosk_order_admissions");
    const columnNames = config.columns.map((column) => column.name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "tenant_id",
        "kiosk_id",
        "device_seq",
        "subscription_id",
        "token_hash",
        "payload_digest",
        "claimed_at",
        "not_after",
      ]),
    );
    expect(columnNames).not.toEqual(
      expect.arrayContaining(["token", "admission_proof", "payload", "raw_payload"]),
    );
    expect(config.foreignKeys.map((key) => key.getName())).toEqual(
      expect.arrayContaining([
        "kiosk_order_admissions_tenant_kiosk_fk",
        "kiosk_order_admissions_tenant_subscription_fk",
      ]),
    );
    expect(config.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "kiosk_order_admissions_tenant_sequence_uq",
    );
    expect(config.checks.map((check) => check.name)).toEqual(
      expect.arrayContaining([
        "kiosk_order_admissions_token_hash_check",
        "kiosk_order_admissions_payload_digest_check",
      ]),
    );
  });
});
