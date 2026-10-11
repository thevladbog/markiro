import { randomUUID } from "node:crypto";
import { ensurePartitions, schema, type Db } from "@markiro/db";
import { sql } from "drizzle-orm";

export interface EvidenceBase {
  tenant: string;
  other: string;
  user: string;
  product: string;
  otherProduct: string;
  lineOne: string;
  lineTwo: string;
  otherLine: string;
  operatorOne: string;
  operatorTwo: string;
  shiftOne: string;
  shiftTwo: string;
  otherShift: string;
  stationDevice: string;
  handheldDevice: string;
  kiosk: string;
}

/** One organisation with two lines, two operators, two shifts and devices, plus a foreign tenant. */
export async function seedEvidenceBase(db: Db): Promise<EvidenceBase> {
  const base: EvidenceBase = {
    tenant: `evidence-a-${randomUUID()}`,
    other: `evidence-b-${randomUUID()}`,
    user: randomUUID(),
    product: randomUUID(),
    otherProduct: randomUUID(),
    lineOne: randomUUID(),
    lineTwo: randomUUID(),
    otherLine: randomUUID(),
    operatorOne: randomUUID(),
    operatorTwo: randomUUID(),
    shiftOne: randomUUID(),
    shiftTwo: randomUUID(),
    otherShift: randomUUID(),
    stationDevice: randomUUID(),
    handheldDevice: randomUUID(),
    kiosk: randomUUID(),
  };
  await ensurePartitions(db, [
    new Date("2026-08-01"),
    new Date("2026-09-01"),
    new Date("2026-10-01"),
    new Date("2026-11-01"),
  ]);
  await db.insert(schema.organization).values([
    { id: base.tenant, name: "Evidence fixture A", slug: base.tenant, createdAt: new Date() },
    { id: base.other, name: "Evidence fixture B", slug: base.other, createdAt: new Date() },
  ]);
  await db.insert(schema.user).values({
    id: base.user,
    name: "Evidence fixture",
    email: `${base.user}@example.invalid`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await db.insert(schema.products).values([
    {
      id: base.product,
      tenantId: base.tenant,
      name: "Evidence product",
      gtin14: "00012345678901",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.otherProduct,
      tenantId: base.other,
      name: "Foreign product",
      gtin14: "00012345678901",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
  await db.insert(schema.lines).values([
    { id: base.lineOne, tenantId: base.tenant, name: "Line one" },
    { id: base.lineTwo, tenantId: base.tenant, name: "Line two" },
    { id: base.otherLine, tenantId: base.other, name: "Foreign line" },
  ]);
  await db.insert(schema.employees).values([
    { id: base.operatorOne, tenantId: base.tenant, fullName: "Operator One" },
    { id: base.operatorTwo, tenantId: base.tenant, fullName: "Operator Two" },
  ]);
  await db.insert(schema.shifts).values([
    {
      id: base.shiftOne,
      tenantId: base.tenant,
      productId: base.product,
      lineId: base.lineOne,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.shiftTwo,
      tenantId: base.tenant,
      productId: base.product,
      lineId: base.lineTwo,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 2,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
    {
      id: base.otherShift,
      tenantId: base.other,
      productId: base.otherProduct,
      lineId: base.otherLine,
      mode: "validation",
      numberMonthKey: "SEP26",
      numberSeq: 1,
      createdFrom: "station",
      productionDate: "2026-09-01",
      createdAt: new Date("2026-08-01T00:00:00Z"),
    },
  ]);
  await db.insert(schema.stationDevices).values([
    { id: base.stationDevice, tenantId: base.tenant, name: "Evidence station" },
    { id: base.handheldDevice, tenantId: base.tenant, name: "Evidence handheld", kind: "handheld" },
  ]);
  await db
    .insert(schema.kiosks)
    .values({ id: base.kiosk, tenantId: base.tenant, name: "Evidence kiosk" });
  return base;
}

// Child tables before their parents. Every table here is tenant-scoped through `tenant_id`.
const EVIDENCE_TABLES = [
  "invoice_payment_completions",
  "billing_payments",
  "billing_acts",
  "invoices",
  "payments",
  "tenant_subscriptions",
  "commercial_offer_lines",
  "commercial_offers",
  "pickup_orders",
  "kiosks",
  "pallet_exceptions",
  "box_exceptions",
  "boxes",
  "pallets",
  "code_conflicts",
  "station_sync_quarantine",
  "sync_batches",
  "inventory_repack_print_attempts",
  "inventory_repack_boxes",
  "inventory_event_claim_outcomes",
  "inventory_code_results",
  "inventory_scan_events",
  "inventory_scan_batches",
  "inventory_snapshot_codes",
  "inventory_snapshots",
  "inventories",
  "station_devices",
  "scan_events",
  "shifts",
  "employees",
  "products",
  "lines",
] as const;

export async function cleanupEvidence(
  db: Db,
  tenants: string[],
  options: { users?: string[]; platformUsers?: string[] } = {},
): Promise<void> {
  const list = sql.join(
    tenants.map((tenant) => sql`${tenant}`),
    sql`, `,
  );
  const platformUsers = options.platformUsers ?? [];
  for (const platformUser of platformUsers) {
    // Agreements may be unlinked (tenant_id null), so remove them by creator.
    await db.execute(
      sql`DELETE FROM platform_agreements WHERE created_by_platform_user_id = ${platformUser}`,
    );
  }
  await db.execute(
    sql`UPDATE inventories SET status='ready', station_manifest=NULL, completed_at=NULL, completed_by_user_id=NULL, completion_acknowledged_at=NULL, completion_acknowledged_by_user_id=NULL WHERE tenant_id IN (${list}) AND active_snapshot_id IS NOT NULL`,
  );
  await db.execute(
    sql`UPDATE inventories SET status='draft', active_snapshot_id=NULL WHERE tenant_id IN (${list})`,
  );
  for (const table of EVIDENCE_TABLES) {
    await db.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE tenant_id IN (${list})`);
  }
  await db.execute(sql`DELETE FROM organization WHERE id IN (${list})`);
  for (const user of options.users ?? [])
    await db.execute(sql`DELETE FROM "user" WHERE id = ${user}`);
  for (const platformUser of platformUsers)
    await db.execute(sql`DELETE FROM platform_users WHERE id = ${platformUser}`);
}
