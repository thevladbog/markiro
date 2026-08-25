import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDb } from "@markiro/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("inventory sync PostgreSQL facts", () => {
  const { pool } = createDb(databaseUrl ?? "", { max: 1 });
  type PoolClient = Parameters<typeof pool.connect>[0] extends (
    error: Error | undefined,
    client: infer Client,
    done: () => void,
  ) => void
    ? Exclude<Client, undefined>
    : never;
  let client: PoolClient;
  let savepointSequence = 0;

  const tenantId = `inventory-sync-${randomUUID()}`;
  const foreignTenantId = `inventory-sync-foreign-${randomUUID()}`;
  const userId = `inventory-sync-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const inventoryId = randomUUID();
  const snapshotId = randomUUID();
  const operatorId = randomUUID();
  const deviceAId = randomUUID();
  const deviceBId = randomUUID();
  const foreignDeviceId = randomUUID();

  async function ensureInventoryExecutionSchema(): Promise<void> {
    const state = await client.query<{ execution: string | null; preparation: string | null }>(
      `select to_regclass('inventory_scan_batches')::text as execution,
              to_regclass('inventories')::text as preparation`,
    );
    const current = state.rows[0];
    if (current?.execution !== null && current?.preparation !== null) return;
    if (current?.execution !== null && current.preparation === null) {
      throw new Error("Inventory sync test schema is partially present; refusing migration replay");
    }

    const migrationNames =
      current?.preparation === null
        ? [
            "0066_panoramic_hemingway.sql",
            "0067_flashy_outlaw_kid.sql",
            "0068_inventory_protected_date_precedence.sql",
            "0069_inventory_station_manifest.sql",
            "0070_curious_big_bertha.sql",
          ]
        : ["0070_curious_big_bertha.sql"];
    for (const migrationName of migrationNames) {
      const migration = readFileSync(
        resolve(process.cwd(), "../../packages/db/migrations", migrationName),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim() !== "") await client.query(statement);
      }
    }
  }

  async function expectConstraintViolation(
    statement: string,
    parameters: readonly unknown[],
    expectedCode: "23502" | "23503" | "23505" | "23514" = "23514",
  ): Promise<void> {
    savepointSequence += 1;
    const savepoint = `inventory_sync_${savepointSequence}`;
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
    await ensureInventoryExecutionSchema();
    await client.query(
      `insert into organization (id, name, slug, created_at)
       values ($1, 'Inventory sync', $2, now()),
              ($3, 'Inventory sync foreign', $4, now())`,
      [
        tenantId,
        `inventory-sync-${randomUUID()}`,
        foreignTenantId,
        `inventory-foreign-${randomUUID()}`,
      ],
    );
    await client.query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'Inventory sync', $2, false, now(), now())`,
      [userId, `${randomUUID()}@example.invalid`],
    );
    await client.query(
      `insert into products (id, tenant_id, gtin14, name)
       values ($1, $2, '04680089900383', 'Inventory sync product')`,
      [productId, tenantId],
    );
    await client.query(`insert into lines (id, tenant_id, name) values ($1, $2, 'Line A')`, [
      lineId,
      tenantId,
    ]);
    await client.query(
      `insert into employees (id, tenant_id, full_name) values ($1, $2, 'Operator')`,
      [operatorId, tenantId],
    );
    await client.query(
      `insert into station_devices (id, tenant_id, name, line_id)
       values ($1, $3, 'Station A', $5), ($2, $3, 'Station B', $5), ($4, $6, 'Foreign station', null)`,
      [deviceAId, deviceBId, tenantId, foreignDeviceId, lineId, foreignTenantId],
    );
    await client.query(
      `insert into inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       values ($1, $2, $3, $4, '04680089900383', $5, 'check', '2026-08-01', '2026-08-31', $6)`,
      [inventoryId, tenantId, `INV-${randomUUID()}`, productId, lineId, userId],
    );
    await client.query(
      `insert into inventory_snapshots
         (id, tenant_id, inventory_id, combined_digest, emitted_count, introduced_count,
          applied_count, retired_count, written_off_count, disaggregation_count, protected_count,
          expected_count, package_count, loose_count, fixed_by_user_id)
       values ($1, $2, $3, $4, 0, 4, 0, 0, 0, 0, 0, 4, 0, 4, $5)`,
      [snapshotId, tenantId, inventoryId, "0".repeat(64), userId],
    );
    await client.query(
      `insert into inventory_snapshot_codes
         (tenant_id, snapshot_id, canonical_raw, code_hash, gtin14, serial, source_status,
          source_production_date, expected, protected)
       values ($1, $2, 'item-1', $3, '04680089900383', 'serial-1', 'INTRODUCED',
               '2026-08-01', true, false),
              ($1, $2, 'item-2', $4, '04680089900383', 'serial-2', 'INTRODUCED',
               '2026-08-01', true, false),
              ($1, $2, 'item-3', $5, '04680089900383', 'serial-3', 'INTRODUCED',
               '2026-08-01', true, false),
              ($1, $2, 'item-4', $6, '04680089900383', 'serial-4', 'INTRODUCED',
               '2026-08-01', true, false)`,
      [tenantId, snapshotId, "1".repeat(64), "2".repeat(64), "3".repeat(64), "4".repeat(64)],
    );
  });

  afterAll(async () => {
    if (client !== undefined) {
      await client.query("rollback");
      client.release();
    }
    await pool.end();
  });

  it("admits one participant per inventory device and rejects a cross-tenant device", async () => {
    await client.query(
      `insert into inventory_device_participants
         (tenant_id, inventory_id, device_id, operator_id, configured_line_id, join_method)
       values ($1, $2, $3, $4, $5, 'assigned_line')`,
      [tenantId, inventoryId, deviceAId, operatorId, lineId],
    );

    await expectConstraintViolation(
      `insert into inventory_device_participants
         (tenant_id, inventory_id, device_id, operator_id, configured_line_id, join_method)
       values ($1, $2, $3, $4, $5, 'task_barcode')`,
      [tenantId, inventoryId, deviceAId, operatorId, lineId],
      "23505",
    );
    await expectConstraintViolation(
      `insert into inventory_device_participants
         (tenant_id, inventory_id, device_id, operator_id, configured_line_id, join_method)
       values ($1, $2, $3, $4, $5, 'task_barcode')`,
      [tenantId, inventoryId, foreignDeviceId, operatorId, lineId],
      "23503",
    );
  });

  it("persists complete replay results, binds batch identity, and keeps events immutable", async () => {
    const eventId = randomUUID();
    await expectConstraintViolation(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome)
       values ($1, $2, $3, 'batch-without-result', $4, 0, 'rejected')`,
      [tenantId, inventoryId, deviceAId, "9".repeat(64)],
      "23502",
    );
    await client.query(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome,
          result)
       values ($1, $2, $3, 'batch-a', $4, 1, 'applied', '{"accepted":1}'::jsonb)`,
      [tenantId, inventoryId, deviceAId, "a".repeat(64)],
    );
    await expectConstraintViolation(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome,
          result)
       values ($1, $2, $3, 'batch-a', $4, 2, 'rejected', '{"error":"conflict"}'::jsonb)`,
      [tenantId, inventoryId, deviceAId, "b".repeat(64)],
      "23505",
    );
    await expectConstraintViolation(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome,
          result)
       values ($1, $2, $3, 'batch-b', $4, 2, 'applied', '{"accepted":0}'::jsonb)`,
      [tenantId, inventoryId, deviceAId, "a".repeat(64)],
      "23505",
    );
    await client.query(
      `insert into inventory_scan_events
         (event_id, tenant_id, inventory_id, batch_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, active_production_date, snapshot_revision,
          local_verdict, authoritative_verdict)
       values ($1, $2, $3, 'batch-a', $4, 1, $5, now(), 'item', '0104680089900383',
               '2026-08-01', 1, 'accepted', 'applied')`,
      [eventId, tenantId, inventoryId, deviceAId, operatorId],
    );
    await expectConstraintViolation(
      `insert into inventory_scan_events
         (event_id, tenant_id, inventory_id, batch_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, snapshot_revision, local_verdict,
          authoritative_verdict)
       values ($1, $2, $3, 'batch-a', $4, 2, $5, now(), 'item', 'different', 1,
               'accepted', 'applied')`,
      [eventId, tenantId, inventoryId, deviceAId, operatorId],
      "23505",
    );
    await expectConstraintViolation(
      `insert into inventory_scan_events
         (event_id, tenant_id, inventory_id, batch_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, snapshot_revision, local_verdict,
          authoritative_verdict)
       values ($1, $2, $3, 'batch-a', $4, 1, $5, now(), 'item', 'different', 1,
               'accepted', 'applied')`,
      [randomUUID(), tenantId, inventoryId, deviceAId, operatorId],
      "23505",
    );
  });

  it("binds known, unknown, and voided results to their immutable origin", async () => {
    const eventIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await client.query(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome,
          result)
       values ($1, $2, $3, 'batch-snapshot-origin', $4, 13, 'applied',
               '{"accepted":4}'::jsonb)`,
      [tenantId, inventoryId, deviceAId, "7".repeat(64)],
    );
    await client.query(
      `insert into inventory_scan_events
         (event_id, tenant_id, inventory_id, batch_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, snapshot_revision, local_verdict,
          authoritative_verdict)
       values ($1, $5, $6, 'batch-snapshot-origin', $7, 10, $8, now(), 'item', 'known', 1,
               'accepted', 'applied'),
              ($2, $5, $6, 'batch-snapshot-origin', $7, 11, $8, now(), 'item', 'unknown', 1,
               'accepted', 'applied'),
              ($3, $5, $6, 'batch-snapshot-origin', $7, 12, $8, now(), 'item', 'voided-known', 1,
               'accepted', 'applied'),
              ($4, $5, $6, 'batch-snapshot-origin', $7, 13, $8, now(), 'item', 'voided-unknown', 1,
               'accepted', 'applied')`,
      [...eventIds, tenantId, inventoryId, deviceAId, operatorId],
    );

    await expectConstraintViolation(
      `insert into inventory_code_results
         (tenant_id, inventory_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, classification, origin_classification)
       values ($1, $2, $3, $4, $5, now(), 'expected', 'expected')`,
      [tenantId, inventoryId, "3".repeat(64), eventIds[0], deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_code_results
         (tenant_id, inventory_id, code_hash, snapshot_id, first_accepted_event_id,
          winning_device_id, winning_scanned_at, classification, origin_classification)
       values ($1, $2, $3, $4, $5, $6, now(), 'unknown', 'unknown')`,
      [tenantId, inventoryId, "3".repeat(64), snapshotId, eventIds[1], deviceAId],
    );

    await client.query(
      `insert into inventory_code_results
         (tenant_id, inventory_id, code_hash, snapshot_id, first_accepted_event_id,
          winning_device_id, winning_scanned_at, classification, origin_classification)
       values ($1, $2, $3, $4, $5, $9, now(), 'expected', 'expected'),
              ($1, $2, $6, null, $7, $9, now(), 'unknown', 'unknown'),
              ($1, $2, $8, $4, $10, $9, now(), 'voided', 'expected'),
              ($1, $2, $11, null, $12, $9, now(), 'voided', 'unknown')`,
      [
        tenantId,
        inventoryId,
        "3".repeat(64),
        snapshotId,
        eventIds[0],
        "5".repeat(64),
        eventIds[1],
        "4".repeat(64),
        deviceAId,
        eventIds[2],
        "6".repeat(64),
        eventIds[3],
      ],
    );
    const stored = await client.query<{
      classification: string;
      origin_classification: string;
      snapshot_id: string | null;
    }>(
      `select classification, origin_classification, snapshot_id
       from inventory_code_results
       where tenant_id = $1 and inventory_id = $2 and code_hash = any($3::char(64)[])
       order by code_hash`,
      [tenantId, inventoryId, ["3".repeat(64), "4".repeat(64), "5".repeat(64), "6".repeat(64)]],
    );
    expect(stored.rows).toEqual([
      { classification: "expected", origin_classification: "expected", snapshot_id: snapshotId },
      { classification: "voided", origin_classification: "expected", snapshot_id: snapshotId },
      { classification: "unknown", origin_classification: "unknown", snapshot_id: null },
      { classification: "voided", origin_classification: "unknown", snapshot_id: null },
    ]);
  });

  it("binds active repack membership to the result date and releases it on removal", async () => {
    const eventAId = randomUUID();
    const eventBId = randomUUID();
    const eventCId = randomUUID();
    const resultAId = randomUUID();
    const resultBId = randomUUID();
    const resultCId = randomUUID();
    const boxAId = randomUUID();
    const boxBId = randomUUID();
    await client.query(
      `insert into inventory_scan_batches
         (tenant_id, inventory_id, device_id, batch_id, payload_digest, sequence_ceiling, outcome,
          result)
       values ($1, $2, $3, 'batch-claims', $4, 5, 'applied', '{"accepted":3}'::jsonb)`,
      [tenantId, inventoryId, deviceAId, "c".repeat(64)],
    );
    await client.query(
      `insert into inventory_scan_events
         (event_id, tenant_id, inventory_id, batch_id, device_id, device_sequence, operator_id,
          scanned_at, kind, normalized_identity, snapshot_revision, local_verdict,
          authoritative_verdict)
       values ($1, $3, $4, 'batch-claims', $5, 3, $6, now(), 'item', 'item-a', 1,
               'accepted', 'applied'),
              ($2, $3, $4, 'batch-claims', $5, 4, $6, now(), 'item', 'item-b', 1,
               'accepted', 'applied'),
              ($7, $3, $4, 'batch-claims', $5, 5, $6, now(), 'item', 'item-c', 1,
               'accepted', 'applied')`,
      [eventAId, eventBId, tenantId, inventoryId, deviceAId, operatorId, eventCId],
    );
    await client.query(
      `insert into inventory_code_results
         (id, tenant_id, inventory_id, code_hash, snapshot_id, first_accepted_event_id,
          winning_device_id, winning_scanned_at, observed_production_date, classification,
          origin_classification)
       values ($1, $4, $5, $6, $9, $10, $12, now(), '2026-08-01', 'expected', 'expected'),
              ($2, $4, $5, $7, $9, $11, $12, now(), '2026-08-01', 'expected', 'expected'),
              ($3, $4, $5, $8, null, $13, $12, now(), null, 'unknown', 'unknown')`,
      [
        resultAId,
        resultBId,
        resultCId,
        tenantId,
        inventoryId,
        "1".repeat(64),
        "2".repeat(64),
        "8".repeat(64),
        snapshotId,
        eventAId,
        eventBId,
        deviceAId,
        eventCId,
      ],
    );
    await expectConstraintViolation(
      `insert into inventory_code_results
         (tenant_id, inventory_id, code_hash, first_accepted_event_id, winning_device_id,
          winning_scanned_at, classification, origin_classification)
       values ($1, $2, $3, $4, $5, now(), 'unknown', 'unknown')`,
      [tenantId, inventoryId, "1".repeat(64), eventBId, deviceAId],
      "23505",
    );
    await client.query(
      `insert into inventory_repack_boxes
         (id, tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, print_state)
       values ($1, $3, $4, '046800899000000001', $5, 12, '2026-08-01', 'open', 'not_ready'),
              ($2, $3, $4, '046800899000000002', $5, 12, '2026-08-02', 'open', 'not_ready')`,
      [boxAId, boxBId, tenantId, inventoryId, deviceAId],
    );
    await client.query(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-01', '2026-08-01')`,
      [tenantId, inventoryId, boxAId, resultAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-01', null)`,
      [tenantId, inventoryId, boxAId, resultBId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-01', '2026-08-01')`,
      [tenantId, inventoryId, boxAId, resultCId],
      "23503",
    );
    await expectConstraintViolation(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-02', '2026-08-02')`,
      [tenantId, inventoryId, boxBId, resultBId],
      "23503",
    );
    await client.query(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-01', '2026-08-01')`,
      [tenantId, inventoryId, boxAId, resultBId],
    );
    await client.query(
      `update inventory_repack_items
       set removed_at = now(), active_observed_production_date = null
       where tenant_id = $1 and inventory_id = $2 and result_id = $3`,
      [tenantId, inventoryId, resultAId],
    );
    await client.query(
      `update inventory_code_results set observed_production_date = '2026-08-02'
       where tenant_id = $1 and inventory_id = $2 and id = $3`,
      [tenantId, inventoryId, resultAId],
    );
    await client.query(
      `insert into inventory_repack_items
         (tenant_id, inventory_id, box_id, result_id, production_date,
          active_observed_production_date)
       values ($1, $2, $3, $4, '2026-08-02', '2026-08-02')`,
      [tenantId, inventoryId, boxBId, resultAId],
    );
    const memberships = await client.query<{
      active_observed_production_date: string | null;
      production_date: string;
      removed: boolean;
    }>(
      `select active_observed_production_date::text, production_date::text,
              removed_at is not null as removed
       from inventory_repack_items
       where tenant_id = $1 and inventory_id = $2 and result_id = $3
       order by production_date`,
      [tenantId, inventoryId, resultAId],
    );
    expect(memberships.rows).toEqual([
      { active_observed_production_date: null, production_date: "2026-08-01", removed: true },
      {
        active_observed_production_date: "2026-08-02",
        production_date: "2026-08-02",
        removed: false,
      },
    ]);
  });

  it("couples repack lifecycle to complete print evidence", async () => {
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, print_state, print_attempt_count, printed_at)
       values ($1, $2, '046800899000000003', $3, 12, '2026-08-01', 'open', 'printed', 1,
               now())`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, print_state, print_attempt_count, print_error_code)
       values ($1, $2, '046800899000000004', $3, 12, '2026-08-01', 'open', 'failed', 1,
               'PRINTER_OFFLINE')`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, closed_at, print_state)
       values ($1, $2, '046800899000000005', $3, 12, '2026-08-01', 'closed', now(),
               'not_ready')`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, print_state, print_attempt_count)
       values ($1, $2, '046800899000000013', $3, 12, '2026-08-01', 'open', 'not_ready', 1)`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, closed_at, print_state, print_attempt_count)
       values ($1, $2, '046800899000000014', $3, 12, '2026-08-01', 'closed', now(),
               'printing', 0)`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, closed_at, print_state, print_attempt_count)
       values ($1, $2, '046800899000000006', $3, 12, '2026-08-01', 'closed', now(),
               'failed', 1)`,
      [tenantId, inventoryId, deviceAId],
    );
    await expectConstraintViolation(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, closed_at, print_state, print_error_code)
       values ($1, $2, '046800899000000007', $3, 12, '2026-08-01', 'closed', now(),
               'pending', 'PRINTER_OFFLINE')`,
      [tenantId, inventoryId, deviceAId],
    );
    await client.query(
      `insert into inventory_repack_boxes
         (tenant_id, inventory_id, new_sscc, owner_device_id, capacity, production_date,
          state, closed_at, print_state, print_attempt_count, print_error_code, printed_at)
       values ($1, $2, '046800899000000008', $3, 12, '2026-08-01', 'open', null,
               'not_ready', 0, null, null),
              ($1, $2, '046800899000000009', $3, 12, '2026-08-01', 'closed', now(),
               'pending', 0, null, null),
              ($1, $2, '046800899000000010', $3, 12, '2026-08-01', 'closed', now(),
               'printing', 1, null, null),
              ($1, $2, '046800899000000011', $3, 12, '2026-08-01', 'closed', now(),
               'printed', 1, null, now()),
              ($1, $2, '046800899000000012', $3, 12, '2026-08-01', 'closed', now(),
               'failed', 1, 'PRINTER_OFFLINE', null)`,
      [tenantId, inventoryId, deviceAId],
    );
  });

  it("requires complete quarantine resolution evidence", async () => {
    await expectConstraintViolation(
      `insert into inventory_late_events
         (tenant_id, inventory_id, device_id, batch_id, payload, payload_digest,
          closed_revision, reason, resolution, resolved_at)
       values ($1, $2, $3, 'late-a', '{}'::jsonb, $4, 1, 'INVENTORY_CLOSED', 'pending', now())`,
      [tenantId, inventoryId, deviceAId, "d".repeat(64)],
    );
    await expectConstraintViolation(
      `insert into inventory_late_events
         (tenant_id, inventory_id, device_id, batch_id, payload, payload_digest,
          closed_revision, reason, resolution, resolved_at)
       values ($1, $2, $3, 'late-b', '{}'::jsonb, $4, 1, 'INVENTORY_CLOSED', 'replayed', now())`,
      [tenantId, inventoryId, deviceAId, "e".repeat(64)],
    );
    await client.query(
      `insert into inventory_late_events
         (tenant_id, inventory_id, device_id, batch_id, payload, payload_digest,
          closed_revision, reason, resolution, resolved_at, resolved_by_user_id)
       values ($1, $2, $3, 'late-c', '{}'::jsonb, $4, 1, 'INVENTORY_CLOSED', 'discarded',
               now(), $5)`,
      [tenantId, inventoryId, deviceAId, "f".repeat(64), userId],
    );
  });
});
