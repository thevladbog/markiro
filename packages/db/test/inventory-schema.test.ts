import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { getTableName, is } from "drizzle-orm";
import { getTableConfig, IndexedColumn, PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "../src/index.js";

const schemaExports = schema as unknown as Record<string, unknown>;

function table(name: string): AnyPgTable {
  const candidate = schemaExports[name];
  if (candidate === undefined) throw new Error(`schema.${name} is missing`);
  return candidate as AnyPgTable;
}

function enumValues(name: string): string[] {
  const candidate = schemaExports[name] as { enumValues?: string[] } | undefined;
  if (candidate?.enumValues === undefined) throw new Error(`schema.${name} is missing`);
  return candidate.enumValues;
}

function constraintColumns(tableName: string, constraintName: string): string[] {
  const constraint = getTableConfig(table(tableName)).uniqueConstraints.find(
    (item) => item.getName() === constraintName,
  );
  if (constraint === undefined) throw new Error(`missing unique constraint ${constraintName}`);
  return constraint.columns.map((column) => column.name);
}

function checkExpression(tableName: string, checkName: string): string {
  const constraint = getTableConfig(table(tableName)).checks.find(
    (item) => item.name === checkName,
  );
  if (constraint === undefined) throw new Error(`missing check ${checkName}`);
  return new PgDialect().sqlToQuery(constraint.value).sql.replaceAll(/"[^"]+"\./g, "");
}

function foreignKeyColumns(
  tableName: string,
  foreignKeyName: string,
): { columns: string[]; foreignColumns: string[]; foreignTable: string } {
  const foreignKey = getTableConfig(table(tableName)).foreignKeys.find(
    (item) => item.getName() === foreignKeyName,
  );
  if (foreignKey === undefined) throw new Error(`missing foreign key ${foreignKeyName}`);
  const reference = foreignKey.reference();
  return {
    columns: reference.columns.map((column) => column.name),
    foreignColumns: reference.foreignColumns.map((column) => column.name),
    foreignTable: getTableName(reference.foreignTable),
  };
}

function indexColumns(tableName: string, indexName: string): string[] {
  const found = getTableConfig(table(tableName)).indexes.find(
    (item) => item.config.name === indexName,
  );
  if (found === undefined) throw new Error(`missing index ${indexName}`);
  return found.config.columns.map((column) =>
    is(column, IndexedColumn) ? (column.name ?? "unnamed") : "expression",
  );
}

describe("inventory preparation schema", () => {
  it("exports the five preparation tables", () => {
    expect(
      [
        "inventories",
        "inventoryImports",
        "inventorySnapshots",
        "inventorySnapshotInputs",
        "inventorySnapshotCodes",
      ].map((name) => getTableName(table(name))),
    ).toEqual([
      "inventories",
      "inventory_imports",
      "inventory_snapshots",
      "inventory_snapshot_inputs",
      "inventory_snapshot_codes",
    ]);
  });

  it("uses only the six approved Chestny ZNAK statuses", () => {
    expect(enumValues("inventoryChzStatusEnum")).toEqual([
      "EMITTED",
      "INTRODUCED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ]);
    expect(enumValues("inventoryChzStatusEnum")).not.toContain("MOVING_BY_UD");
  });

  it("pins the lifecycle, mode, container, and parse-outcome values", () => {
    expect(enumValues("inventoryLifecycleStatusEnum")).toEqual([
      "draft",
      "preparing",
      "ready",
      "running",
      "closed",
      "completed",
    ]);
    expect(enumValues("inventoryModeEnum")).toEqual(["check", "repack"]);
    expect(enumValues("inventoryImportContainerKindEnum")).toEqual(["csv", "zip", "xlsx"]);
    expect(enumValues("inventoryImportParseOutcomeEnum")).toEqual(["succeeded", "failed"]);
  });

  it("tenant-scopes every inventory-owned relation, including the active snapshot", () => {
    expect(foreignKeyColumns("inventories", "inventories_tenant_product_fk")).toEqual({
      columns: ["tenant_id", "product_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "products",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_line_fk")).toEqual({
      columns: ["tenant_id", "line_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "lines",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_box_label_template_fk")).toEqual({
      columns: ["tenant_id", "box_label_template_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "label_templates",
    });
    expect(foreignKeyColumns("inventories", "inventories_tenant_active_snapshot_fk")).toEqual({
      columns: ["tenant_id", "active_snapshot_id", "id"],
      foreignColumns: ["tenant_id", "id", "inventory_id"],
      foreignTable: "inventory_snapshots",
    });
    expect(foreignKeyColumns("inventoryImports", "inventory_imports_tenant_inventory_fk")).toEqual({
      columns: ["tenant_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventories",
    });
    expect(
      foreignKeyColumns("inventorySnapshots", "inventory_snapshots_tenant_inventory_fk"),
    ).toEqual({
      columns: ["tenant_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventories",
    });
    expect(
      foreignKeyColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_snapshot_inventory_fk",
      ),
    ).toEqual({
      columns: ["tenant_id", "snapshot_id", "inventory_id"],
      foreignColumns: ["tenant_id", "id", "inventory_id"],
      foreignTable: "inventory_snapshots",
    });
    expect(
      foreignKeyColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_import_inventory_status_fk",
      ),
    ).toEqual({
      columns: ["tenant_id", "import_id", "inventory_id", "status", "import_parse_outcome"],
      foreignColumns: ["tenant_id", "id", "inventory_id", "declared_status", "parse_outcome"],
      foreignTable: "inventory_imports",
    });
    expect(
      foreignKeyColumns("inventorySnapshotCodes", "inventory_snapshot_codes_tenant_snapshot_fk"),
    ).toEqual({
      columns: ["tenant_id", "snapshot_id"],
      foreignColumns: ["tenant_id", "id"],
      foreignTable: "inventory_snapshots",
    });

    for (const [tableName, foreignKeyName] of [
      ["inventories", "inventories_tenant_active_snapshot_fk"],
      ["inventoryImports", "inventory_imports_tenant_inventory_fk"],
      ["inventorySnapshots", "inventory_snapshots_tenant_inventory_fk"],
      ["inventorySnapshotInputs", "inventory_snapshot_inputs_tenant_snapshot_inventory_fk"],
      ["inventorySnapshotInputs", "inventory_snapshot_inputs_tenant_import_inventory_status_fk"],
      ["inventorySnapshotCodes", "inventory_snapshot_codes_tenant_snapshot_fk"],
    ] as const) {
      const key = getTableConfig(table(tableName)).foreignKeys.find(
        (item) => item.getName() === foreignKeyName,
      );
      expect(key?.onDelete, `${foreignKeyName} must retain evidence on delete`).toBe("no action");
      expect(key?.onUpdate, `${foreignKeyName} must retain identity on update`).toBe("no action");
    }
  });

  it("permits only one immutable snapshot and one selected import per status", () => {
    expect(
      constraintColumns("inventorySnapshots", "inventory_snapshots_tenant_inventory_uq"),
    ).toEqual(["tenant_id", "inventory_id"]);
    expect(
      constraintColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_snapshot_status_uq",
      ),
    ).toEqual(["tenant_id", "snapshot_id", "status"]);
    expect(
      constraintColumns("inventorySnapshotCodes", "inventory_snapshot_codes_tenant_hash_uq"),
    ).toEqual(["tenant_id", "snapshot_id", "code_hash"]);
    expect(
      constraintColumns(
        "inventoryImports",
        "inventory_imports_tenant_id_inventory_status_outcome_uq",
      ),
    ).toEqual(["tenant_id", "id", "inventory_id", "declared_status", "parse_outcome"]);
    expect(
      constraintColumns("inventorySnapshots", "inventory_snapshots_tenant_id_inventory_uq"),
    ).toEqual(["tenant_id", "id", "inventory_id"]);
  });

  it("requires complete successful parse facts and a sanitized failure", () => {
    const expression = checkExpression("inventoryImports", "inventory_imports_parse_outcome_check");

    expect(expression).toContain('"parsed_status" is not null');
    expect(expression).toContain('"included_gtin14" is not null');
    expect(expression).toContain('"error_count" = 0');
    expect(expression).toContain('"error_code" is null');
    expect(expression).toContain('"error_count" > 0');
    expect(expression).toContain('"error_code" is not null');
  });

  it("selects only a successful import through a checked composite foreign key", () => {
    expect(Object.keys(schema.inventorySnapshotInputs)).toContain("importParseOutcome");
    expect(
      checkExpression(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_successful_import_check",
      ),
    ).toContain("\"import_parse_outcome\" = 'succeeded'");
    expect(
      foreignKeyColumns(
        "inventorySnapshotInputs",
        "inventory_snapshot_inputs_tenant_import_inventory_status_fk",
      ),
    ).toEqual({
      columns: ["tenant_id", "import_id", "inventory_id", "status", "import_parse_outcome"],
      foreignColumns: ["tenant_id", "id", "inventory_id", "declared_status", "parse_outcome"],
      foreignTable: "inventory_imports",
    });
  });

  it("requires a source production date for every introduced snapshot code", () => {
    const expression = checkExpression(
      "inventorySnapshotCodes",
      "inventory_snapshot_codes_classification_check",
    );

    expect(expression).toContain(
      '("source_status" <> \'INTRODUCED\' or "source_production_date" is not null)',
    );
    expect(expression).toContain(
      '"protected" = coalesce("source_state" = \'MOVING_BY_UD\', false)',
    );
  });

  it("pairs lifecycle evidence and requires completion acknowledgement", () => {
    expect(checkExpression("inventories", "inventories_started_fields_check")).toContain(
      '("started_by_user_id" is null and "started_at" is null)',
    );
    expect(checkExpression("inventories", "inventories_closed_fields_check")).toContain(
      '("closed_by_user_id" is null and "closed_at" is null)',
    );
    expect(checkExpression("inventories", "inventories_completed_fields_check")).toContain(
      '("completed_by_user_id" is null and "completed_at" is null)',
    );
    const lifecycle = checkExpression("inventories", "inventories_completed_lifecycle_check");
    expect(lifecycle).toContain("\"status\" = 'completed'");
    expect(lifecycle).toContain('"completion_acknowledged_by_user_id" is not null');
    expect(lifecycle).toContain('"completion_acknowledged_at" is not null');
    const emergency = checkExpression("inventories", "inventories_emergency_close_fields_check");
    expect(emergency).toContain('"emergency_close_reason" is null');
    expect(emergency).toContain('"emergency_closed_by_user_id" is null');
    expect(emergency).toContain('"emergency_closed_at" is null');
    expect(emergency).toContain('"emergency_close_reason" is not null');
    expect(emergency).toContain('"emergency_closed_by_user_id" is not null');
    expect(emergency).toContain('"emergency_closed_at" is not null');
  });

  it("declares date, digest, count, lifecycle, mode, and classification checks", () => {
    const checks = [
      ...getTableConfig(table("inventories")).checks,
      ...getTableConfig(table("inventoryImports")).checks,
      ...getTableConfig(table("inventorySnapshots")).checks,
      ...getTableConfig(table("inventorySnapshotCodes")).checks,
    ].map((item) => item.name);

    expect(checks).toEqual(
      expect.arrayContaining([
        "inventories_production_date_order_check",
        "inventories_result_revision_nonnegative_check",
        "inventories_mode_template_check",
        "inventories_active_snapshot_lifecycle_check",
        "inventory_imports_byte_size_nonnegative_check",
        "inventory_imports_sha256_check",
        "inventory_imports_counts_nonnegative_check",
        "inventory_imports_parse_outcome_check",
        "inventory_snapshots_revision_positive_check",
        "inventory_snapshots_combined_digest_check",
        "inventory_snapshots_counts_nonnegative_check",
        "inventory_snapshot_codes_hash_check",
        "inventory_snapshot_codes_gtin14_check",
        "inventory_snapshot_codes_parent_sscc_check",
        "inventory_snapshot_codes_classification_check",
      ]),
    );
  });

  it("indexes inventory listing, import selection, package expansion, and expected dates", () => {
    expect(indexColumns("inventories", "inventories_tenant_status_dates_idx")).toEqual([
      "tenant_id",
      "status",
      "production_date_from",
      "production_date_to",
    ]);
    expect(
      indexColumns("inventoryImports", "inventory_imports_inventory_status_created_idx"),
    ).toEqual(["tenant_id", "inventory_id", "declared_status", "created_at"]);
    expect(
      indexColumns("inventorySnapshotCodes", "inventory_snapshot_codes_parent_sscc_idx"),
    ).toEqual(["snapshot_id", "parent_sscc"]);
    expect(
      indexColumns("inventorySnapshotCodes", "inventory_snapshot_codes_expected_date_idx"),
    ).toEqual(["snapshot_id", "expected", "source_production_date"]);
  });
});

const databaseUrl = process.env.DATABASE_URL;

const inventoryTestTables = [
  "inventories",
  "inventory_imports",
  "inventory_snapshots",
  "inventory_snapshot_inputs",
  "inventory_snapshot_codes",
] as const;
const inventoryTestEnums = [
  "inventory_chz_status",
  "inventory_lifecycle_status",
  "inventory_mode",
  "inventory_import_container_kind",
  "inventory_import_parse_outcome",
] as const;
const inventoryCurrentConstraints = [
  "inventories_started_fields_check",
  "inventories_closed_fields_check",
  "inventories_completed_fields_check",
  "inventories_completed_lifecycle_check",
  "inventory_imports_tenant_id_inventory_status_outcome_uq",
  "inventory_snapshot_inputs_successful_import_check",
] as const;
type InventorySchemaSetupResult = "provisioned" | "existing";

async function inspectInventoryTestSchema(client: pg.PoolClient): Promise<"absent" | "current"> {
  const [tables, enums] = await Promise.all([
    client.query<{ name: string }>(
      `select relation.relname as name
       from pg_class relation
       join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = current_schema()
         and relation.relkind in ('r', 'p')
         and relation.relname = any($1::text[])`,
      [inventoryTestTables],
    ),
    client.query<{ name: string }>(
      `select type.typname as name
       from pg_type type
       join pg_namespace namespace on namespace.oid = type.typnamespace
       where namespace.nspname = current_schema()
         and type.typtype = 'e'
         and type.typname = any($1::text[])`,
      [inventoryTestEnums],
    ),
  ]);

  if (tables.rowCount === 0 && enums.rowCount === 0) return "absent";
  if (
    tables.rowCount !== inventoryTestTables.length ||
    enums.rowCount !== inventoryTestEnums.length
  ) {
    throw new Error(
      `Inventory test schema is partially present (${tables.rowCount}/${inventoryTestTables.length} tables, ${enums.rowCount}/${inventoryTestEnums.length} enums); refusing migration replay`,
    );
  }

  const [outcomeColumn, constraints] = await Promise.all([
    client.query<{ column_default: string | null; is_nullable: "YES" | "NO" }>(
      `select is_nullable, column_default
       from information_schema.columns
       where table_schema = current_schema()
         and table_name = 'inventory_snapshot_inputs'
         and column_name = 'import_parse_outcome'`,
    ),
    client.query<{ name: string }>(
      `select constraint_record.conname as name
       from pg_constraint constraint_record
       join pg_namespace namespace on namespace.oid = constraint_record.connamespace
       where namespace.nspname = current_schema()
         and constraint_record.conname = any($1::text[])`,
      [inventoryCurrentConstraints],
    ),
  ]);
  const column = outcomeColumn.rows[0];
  const foundConstraints = new Set(constraints.rows.map((row) => row.name));
  const missingInvariantCount =
    (column?.is_nullable === "NO" && column.column_default?.includes("'succeeded'") === true
      ? 0
      : 1) + inventoryCurrentConstraints.filter((name) => !foundConstraints.has(name)).length;
  if (missingInvariantCount !== 0) {
    throw new Error(
      `Inventory test schema is incompatible (${missingInvariantCount} current invariant(s) missing); refusing migration replay`,
    );
  }
  return "current";
}

async function ensureInventoryTestSchema(
  client: pg.PoolClient,
): Promise<InventorySchemaSetupResult> {
  if ((await inspectInventoryTestSchema(client)) === "current") return "existing";

  for (const migrationName of ["0066_panoramic_hemingway.sql", "0067_flashy_outlaw_kid.sql"]) {
    const migration = readFileSync(
      new URL(`../migrations/${migrationName}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim() !== "") await client.query(statement);
    }
  }
  if ((await inspectInventoryTestSchema(client)) !== "current") {
    throw new Error("Inventory test schema provisioning did not produce the current schema");
  }
  return "provisioned";
}

describe.skipIf(!databaseUrl)("inventory preparation PostgreSQL invariants", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  let client: pg.PoolClient;
  const tenantId = `inventory-review-${randomUUID()}`;
  const userId = `inventory-review-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const inventoryId = randomUUID();
  const snapshotId = randomUUID();
  const failedImportId = randomUUID();
  let savepointSequence = 0;
  let schemaSetupResults: readonly [InventorySchemaSetupResult, InventorySchemaSetupResult];

  async function expectConstraintViolation(
    statement: string,
    parameters: readonly unknown[],
    expectedCode: "23503" | "23514" = "23514",
  ): Promise<void> {
    savepointSequence += 1;
    const savepoint = `inventory_review_${savepointSequence}`;
    await client.query(`savepoint ${savepoint}`);
    let caught: unknown;
    try {
      await client.query(statement, [...parameters]);
    } catch (error) {
      caught = error;
    } finally {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
    }
    expect(caught).toMatchObject({ code: expectedCode });
  }

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("begin");
    schemaSetupResults = [
      await ensureInventoryTestSchema(client),
      await ensureInventoryTestSchema(client),
    ];
    await client.query(
      `insert into organization (id, name, slug, created_at) values ($1, $2, $3, now())`,
      [tenantId, "Inventory review", `inventory-review-${randomUUID()}`],
    );
    await client.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, $2, $3, false, now(), now())`,
      [userId, "Inventory review", `${randomUUID()}@example.invalid`],
    );
    await client.query(
      `insert into products (id, tenant_id, gtin14, name) values ($1, $2, $3, $4)`,
      [productId, tenantId, "04680089900383", "Inventory review product"],
    );
    await client.query(`insert into lines (id, tenant_id, name) values ($1, $2, $3)`, [
      lineId,
      tenantId,
      "Inventory review line",
    ]);
    await client.query(
      `insert into inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       values ($1, $2, $3, $4, $5, $6, 'check', '2026-08-01', '2026-08-31', $7)`,
      [inventoryId, tenantId, `INV-${randomUUID()}`, productId, "04680089900383", lineId, userId],
    );
    await client.query(
      `insert into inventory_imports
         (id, tenant_id, inventory_id, declared_status, file_name, container_kind,
          byte_size, sha256, object_key, parse_outcome, row_count, error_count,
          duplicate_count, error_code, created_by_user_id)
       values ($1, $2, $3, 'EMITTED', 'failed.csv', 'csv', 1, $4, 'private/failed',
               'failed', 0, 1, 0, 'CHZ_FILTER_INVALID', $5)`,
      [failedImportId, tenantId, inventoryId, "f".repeat(64), userId],
    );
    await client.query(
      `insert into inventory_snapshots
         (id, tenant_id, inventory_id, combined_digest, emitted_count, introduced_count,
          applied_count, retired_count, written_off_count, disaggregation_count,
          protected_count, expected_count, package_count, loose_count, fixed_by_user_id)
       values ($1, $2, $3, $4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $5)`,
      [snapshotId, tenantId, inventoryId, "d".repeat(64), userId],
    );
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.query("rollback");
      client.release();
    }
    await pool.end();
  });

  it("reuses the current inventory schema instead of replaying migrations", () => {
    expect(schemaSetupResults[0]).toMatch(/^(provisioned|existing)$/);
    expect(schemaSetupResults[1]).toBe("existing");
  });

  it("rejects an incompatible existing inventory schema without replaying migrations", async () => {
    const savepoint = "inventory_review_incompatible_schema";
    await client.query(`savepoint ${savepoint}`);
    try {
      await client.query(
        `alter table inventory_snapshot_inputs
         drop constraint inventory_snapshot_inputs_successful_import_check`,
      );
      await expect(ensureInventoryTestSchema(client)).rejects.toThrow(
        "Inventory test schema is incompatible (1 current invariant(s) missing); refusing migration replay",
      );
    } finally {
      await client.query(`rollback to savepoint ${savepoint}`);
      await client.query(`release savepoint ${savepoint}`);
    }
  });

  it("rejects incomplete or contradictory import outcomes", async () => {
    const statement = `insert into inventory_imports
         (tenant_id, inventory_id, declared_status, file_name, container_kind, byte_size,
          sha256, object_key, parsed_status, included_gtin14, parse_outcome, row_count,
          error_count, duplicate_count, error_code, created_by_user_id)
       values ($1, $2, 'INTRODUCED', 'invalid.csv', 'csv', 1, $3, 'private/invalid',
               $4, $5, $6, 0, $7, 0, $8, $9)`;
    const cases = [
      [null, "04680089900383", "succeeded", 0, null],
      ["INTRODUCED", null, "succeeded", 0, null],
      ["INTRODUCED", "04680089900383", "succeeded", 1, "UNEXPECTED_ERROR"],
      [null, null, "failed", 1, null],
      [null, null, "failed", 0, "PARSE_FAILED"],
    ] as const;

    for (const [parsedStatus, includedGtin14, outcome, errorCount, errorCode] of cases) {
      await expectConstraintViolation(statement, [
        tenantId,
        inventoryId,
        "a".repeat(64),
        parsedStatus,
        includedGtin14,
        outcome,
        errorCount,
        errorCode,
        userId,
      ]);
    }
  });

  it("rejects selecting a failed import for a snapshot", async () => {
    const columns = await client.query<{ present: boolean }>(
      `select exists (
         select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'inventory_snapshot_inputs'
           and column_name = 'import_parse_outcome'
       ) as present`,
    );
    const statement = columns.rows[0]?.present
      ? `insert into inventory_snapshot_inputs
           (tenant_id, snapshot_id, inventory_id, status, import_id, import_parse_outcome)
         values ($1, $2, $3, 'EMITTED', $4, 'succeeded')`
      : `insert into inventory_snapshot_inputs
           (tenant_id, snapshot_id, inventory_id, status, import_id)
         values ($1, $2, $3, 'EMITTED', $4)`;

    await expectConstraintViolation(
      statement,
      [tenantId, snapshotId, inventoryId, failedImportId],
      "23503",
    );
  });

  it("rejects an introduced snapshot code without a source production date", async () => {
    await expectConstraintViolation(
      `insert into inventory_snapshot_codes
         (tenant_id, snapshot_id, canonical_raw, code_hash, gtin14, serial, source_status,
          source_production_date, expected, protected)
       values ($1, $2, 'raw-km', $3, '04680089900383', 'SERIAL', 'INTRODUCED', null, false, false)`,
      [tenantId, snapshotId, "b".repeat(64)],
    );

    for (const [index, status] of [
      "EMITTED",
      "APPLIED",
      "RETIRED",
      "WRITTEN_OFF",
      "DISAGGREGATION",
    ].entries()) {
      await client.query(
        `insert into inventory_snapshot_codes
           (tenant_id, snapshot_id, canonical_raw, code_hash, gtin14, serial, source_status,
            source_production_date, expected, protected)
         values ($1, $2, $3, $4, '04680089900383', $5, $6, null, false, false)`,
        [tenantId, snapshotId, `raw-${status}`, index.toString(16).repeat(64), status, status],
      );
    }
    await client.query(
      `insert into inventory_snapshot_codes
         (tenant_id, snapshot_id, canonical_raw, code_hash, gtin14, serial, source_status,
          source_state, source_production_date, expected, protected)
       values ($1, $2, 'raw-protected', $3, '04680089900383', 'PROTECTED', 'INTRODUCED',
               'MOVING_BY_UD', '2026-08-15', false, true)`,
      [tenantId, snapshotId, "f".repeat(64)],
    );
  });

  it("rejects partial start and close evidence", async () => {
    const values = [tenantId, productId, lineId, userId, `INV-${randomUUID()}`, randomUUID()];
    await expectConstraintViolation(
      `insert into inventories
         (tenant_id, number, id, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id, started_by_user_id)
       values ($1, $5, $6, $2, '04680089900383', $3, 'check', '2026-08-01', '2026-08-31', $4, $4)`,
      values,
    );
    values[4] = `INV-${randomUUID()}`;
    values[5] = randomUUID();
    await expectConstraintViolation(
      `insert into inventories
         (tenant_id, number, id, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id, closed_at)
       values ($1, $5, $6, $2, '04680089900383', $3, 'check', '2026-08-01', '2026-08-31', $4, now())`,
      values,
    );
  });

  it("rejects completion without explicit acknowledgement", async () => {
    await expectConstraintViolation(
      `update inventories
       set status = 'completed', active_snapshot_id = $1,
           completed_by_user_id = $2, completed_at = now()
       where tenant_id = $3 and id = $4`,
      [snapshotId, userId, tenantId, inventoryId],
    );
    await expectConstraintViolation(
      `update inventories
       set completion_acknowledged_by_user_id = $1, completion_acknowledged_at = now()
       where tenant_id = $2 and id = $3`,
      [userId, tenantId, inventoryId],
    );
    await expectConstraintViolation(
      `update inventories
       set status = 'completed', active_snapshot_id = $1,
           completion_acknowledged_by_user_id = $2, completion_acknowledged_at = now()
       where tenant_id = $3 and id = $4`,
      [snapshotId, userId, tenantId, inventoryId],
    );
  });
});
