import { STATION_MIGRATIONS, type OperatorMirrorRecord } from "@markiro/db";

/** Backend-agnostic SQL surface so mirror logic is testable with node:sqlite. */
export interface SqlExecutor {
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Station-side mirror of the server ShiftBundleDto (Task 7). */
export interface StationBundle {
  shift: {
    id: string;
    status: string;
    mode: string;
    productId: string;
    productName: string | null;
    lineId: string | null;
    lineName: string | null;
    counterpartyId: string | null;
    counterpartyName: string | null;
    labelTemplateId: string | null;
    labelTemplateName: string | null;
    plannedQty: number | null;
    plannedDate: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    palletsEnabled: boolean;
    openedAt: string | null;
  };
  product: {
    id: string;
    gtin14: string;
    name: string;
    productGroup: string | null;
    boxCapacity: number | null;
    palletCapacity: number | null;
    status: string;
    defaultCounterpartyId: string | null;
    defaultLabelTemplateId: string | null;
  };
  labelTemplate: { id: string; name: string; spec: unknown } | null;
  counterpartyGln: string | null;
  operators: OperatorMirrorRecord[];
}

export interface ShiftMirrorRow {
  id: string;
  status: string;
  mode: string;
  counterpartyGln: string | null;
  labelTemplateSpec: string | null;
}

export async function applyMigrations(exec: SqlExecutor): Promise<void> {
  for (const stmt of STATION_MIGRATIONS) await exec.run(stmt);
}

const b = (v: boolean) => (v ? 1 : 0);

/** Idempotent upsert of a downloaded bundle into the local mirror tables. */
export async function upsertBundle(exec: SqlExecutor, bundle: StationBundle): Promise<void> {
  const s = bundle.shift;
  await exec.run(
    `INSERT INTO shift_mirror (
       id, status, mode, product_id, product_name, line_id, line_name,
       counterparty_id, counterparty_name, counterparty_gln,
       label_template_id, label_template_name, label_template_spec,
       planned_qty, planned_date, box_capacity, pallet_capacity, pallets_enabled, opened_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status, mode=excluded.mode, product_name=excluded.product_name,
       line_id=excluded.line_id, line_name=excluded.line_name,
       counterparty_id=excluded.counterparty_id, counterparty_name=excluded.counterparty_name,
       counterparty_gln=excluded.counterparty_gln, label_template_id=excluded.label_template_id,
       label_template_name=excluded.label_template_name, label_template_spec=excluded.label_template_spec,
       planned_qty=excluded.planned_qty, planned_date=excluded.planned_date,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       pallets_enabled=excluded.pallets_enabled, opened_at=excluded.opened_at`,
    [
      s.id,
      s.status,
      s.mode,
      s.productId,
      s.productName,
      s.lineId,
      s.lineName,
      s.counterpartyId,
      s.counterpartyName,
      bundle.counterpartyGln,
      s.labelTemplateId,
      s.labelTemplateName,
      bundle.labelTemplate ? JSON.stringify(bundle.labelTemplate.spec) : null,
      s.plannedQty,
      s.plannedDate,
      s.boxCapacity,
      s.palletCapacity,
      b(s.palletsEnabled),
      s.openedAt,
    ],
  );

  const p = bundle.product;
  await exec.run(
    `INSERT INTO product_mirror (
       id, gtin14, name, product_group, box_capacity, pallet_capacity, status,
       default_counterparty_id, default_label_template_id
     ) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       gtin14=excluded.gtin14, name=excluded.name, product_group=excluded.product_group,
       box_capacity=excluded.box_capacity, pallet_capacity=excluded.pallet_capacity,
       status=excluded.status, default_counterparty_id=excluded.default_counterparty_id,
       default_label_template_id=excluded.default_label_template_id`,
    [
      p.id,
      p.gtin14,
      p.name,
      p.productGroup,
      p.boxCapacity,
      p.palletCapacity,
      p.status,
      p.defaultCounterpartyId,
      p.defaultLabelTemplateId,
    ],
  );

  for (const op of bundle.operators) {
    await exec.run(
      `INSERT INTO operators_mirror (operator_id, name, role, pin_hash, badge_hash, active)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(operator_id) DO UPDATE SET
         name=excluded.name, role=excluded.role, pin_hash=excluded.pin_hash,
         badge_hash=excluded.badge_hash, active=excluded.active`,
      [op.operatorId, op.name, op.role, op.pinHash, op.badgeHash, b(op.active)],
    );
  }
}

export async function readShiftMirror(
  exec: SqlExecutor,
  id: string,
): Promise<ShiftMirrorRow | null> {
  const rows = await exec.all<{
    id: string;
    status: string;
    mode: string;
    counterparty_gln: string | null;
    label_template_spec: string | null;
  }>(
    "SELECT id, status, mode, counterparty_gln, label_template_spec FROM shift_mirror WHERE id = ?",
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    status: r.status,
    mode: r.mode,
    counterpartyGln: r.counterparty_gln,
    labelTemplateSpec: r.label_template_spec,
  };
}

export async function readOperatorsMirror(exec: SqlExecutor): Promise<OperatorMirrorRecord[]> {
  const rows = await exec.all<{
    operator_id: string;
    name: string;
    role: string;
    pin_hash: string;
    badge_hash: string | null;
    active: number;
  }>("SELECT operator_id, name, role, pin_hash, badge_hash, active FROM operators_mirror");
  return rows.map((r) => ({
    operatorId: r.operator_id,
    name: r.name,
    role: r.role,
    pinHash: r.pin_hash,
    badgeHash: r.badge_hash,
    active: r.active === 1,
  }));
}
