import { buildSscc, DomainError, isValidSscc, labelTemplateSpecSchema } from "@markiro/domain";
import { z } from "zod";

import { boxRegistryItemSchema } from "../../host/pallet-assembly.js";
import type { LocalStatement } from "../../local/executor.js";
import { PALLET_SSCC_HELD_SQL } from "../pallets/pallets.js";
import type {
  PalletAssemblyConflict,
  PalletAssemblyPallet,
  PalletAssemblyStore,
} from "./contracts.js";
import { createAssemblyPrintStore } from "./print-store.js";
import { readPalletRegistryState } from "./registry.js";
import { BLOCKING_ASSEMBLY_RECEIPT } from "./sender.js";
import {
  applyAssemblyChange,
  ASSEMBLY_OPERATOR,
  assemblyEvent,
  type PalletAssemblyContext,
} from "./statements.js";

const NOT_BLOCKED =
  "NOT EXISTS (SELECT 1 FROM pallet_assembly_outbox " +
  `WHERE host_id = ? AND device_id = ? AND ${BLOCKING_ASSEMBLY_RECEIPT})`;

const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  printName: z.string().nullable(),
  gtin14: z.string(),
  shelfLifeDays: z.number().int().nullable(),
  capacity: z.number().int().positive().nullable(),
  chzGroupCode: z.number().int().nullable(),
});
const labelSchema = z.object({
  template: labelTemplateSpecSchema,
  boxCount: z.number().int().positive(),
  itemCount: z.number().int().nonnegative(),
  productionDate: z.string().nullable(),
});
const palletRow = z.object({
  id: z.string(),
  product: z.string(),
  opened_at: z.string(),
  revision: z.number().int(),
  closed_at: z.string().nullable(),
  sscc: z.string().nullable(),
  label: z.string().nullable(),
  label_version: z.number().int().nonnegative(),
  accepted_members: z.string().nullable(),
  print_state: z.enum(["pending", "printing", "sent", "failed", "unknown", "confirmed"]),
  print_reason: z.string().nullable(),
  deferred: z.number().int(),
  cancelled: z.number().int(),
  sync_state: z.enum(["pending", "accepted", "rejected"]),
});
const memberRow = z.object({
  sscc: z.string(),
  shiftNumber: z.string().nullable(),
  productionDate: z.string().nullable(),
  itemCount: z.number().int().nonnegative(),
  syncState: z.enum(["pending", "accepted"]),
});
const conflictRow = z.object({
  palletId: z.string(),
  palletSscc: z.string().nullable(),
  boxSscc: z.string().nullable(),
  winningPalletSscc: z.string().nullable(),
  closeIssueId: z.string().nullable(),
  code: z.string(),
  acknowledged: z.number().int(),
  blocksAssembly: z.number().int(),
  canAbandon: z.number().int(),
});
const registryRow = z.object({ payload: z.string(), refreshed_at: z.string() });
const ownerRow = z.object({ n: z.literal(1) });
const occupiedRow = z.object({ sscc: z.string().nullable() });
const blockRow = z.object({ block_id: z.string(), next_serial: z.number().int().nonnegative() });
const ACTIVE_MEMBER = "m.removed_at IS NULL AND o.outcome IS NOT 'rejected'";
const ACCEPTED_MEMBER =
  "(p.accepted_members IS NULL OR m.sscc IN (SELECT value FROM json_each(p.accepted_members)))";
const LOCALLY_OCCUPIED =
  "FROM pallet_assembly_members m JOIN pallet_assembly_pallets p ON p.id = m.pallet_id " +
  "JOIN pallet_assembly_outbox o ON o.id = m.add_id WHERE m.host_id = ? AND m.device_id = ? " +
  `AND m.sscc = ? AND ${ACTIVE_MEMBER} AND ${ACCEPTED_MEMBER} AND p.cancelled_at IS NULL AND (p.closed_at IS NULL OR NOT EXISTS (SELECT 1 ` +
  "FROM pallet_assembly_outbox c WHERE c.pallet_id = p.id AND c.host_id = p.host_id " +
  "AND c.device_id = p.device_id AND c.kind = 'warehouse_pallet_closed' AND c.outcome = 'accepted' AND c.acked_at < ?))";
const PALLET_FIELDS =
  "p.id, p.product, p.opened_at, p.revision, p.closed_at, p.sscc, " +
  "coalesce(p.accepted_label, p.label) AS label, p.accepted_members, p.label_version, " +
  "p.print_state, p.print_reason, p.deferred, p.cancelled_at IS NOT NULL AS cancelled, " +
  "CASE WHEN p.cancelled_at IS NOT NULL OR EXISTS (SELECT 1 FROM pallet_assembly_outbox o " +
  "WHERE o.host_id = p.host_id AND o.device_id = p.device_id AND o.pallet_id = p.id " +
  `AND ${BLOCKING_ASSEMBLY_RECEIPT}) OR (p.closed_at IS NOT NULL AND (coalesce(p.accepted_label, p.label) ->> 'boxCount') <> ` +
  "(SELECT count(*) FROM pallet_assembly_members m JOIN pallet_assembly_outbox o ON o.id = m.add_id " +
  `WHERE m.pallet_id = p.id AND ${ACTIVE_MEMBER} AND ${ACCEPTED_MEMBER})) THEN 'rejected' ` +
  "WHEN EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.host_id = p.host_id " +
  "AND o.device_id = p.device_id AND o.pallet_id = p.id AND o.kind = 'warehouse_pallet_closed' " +
  "AND o.outcome = 'accepted') THEN 'accepted' ELSE 'pending' END AS sync_state";

export function createPalletAssemblyStore(context: PalletAssemblyContext): PalletAssemblyStore {
  const {
    local,
    pairing,
    operatorId,
    now = () => new Date(),
    newId = () => crypto.randomUUID(),
  } = context;
  const owner = [pairing.hostId, pairing.deviceId];
  const actor = [operatorId, ...owner];
  const at = () => now().toISOString();

  const select = (condition: string, values: readonly unknown[] = []) =>
    local.query(
      `SELECT ${PALLET_FIELDS} FROM pallet_assembly_pallets p WHERE p.host_id = ? AND p.device_id = ? ${condition}`,
      [...owner, ...values],
      palletRow,
    );
  const openRows = () => select("AND p.closed_at IS NULL AND p.abandoned_at IS NULL");
  const getRow = (id: string) => select("AND p.id = ?", [id]);
  const authorized = async () =>
    (await local.query(`SELECT 1 AS n WHERE ${ASSEMBLY_OPERATOR}`, actor, ownerRow)).length > 0;
  const unblocked = async () =>
    (await local.query(`SELECT 1 AS n WHERE ${NOT_BLOCKED}`, owner, ownerRow)).length > 0;

  async function toPallet(row: z.infer<typeof palletRow>): Promise<PalletAssemblyPallet> {
    const boxes = await local.query(
      "SELECT m.sscc, m.shift_number AS shiftNumber, m.production_date AS productionDate, " +
        "m.item_count AS itemCount, coalesce(o.outcome, 'pending') AS syncState FROM pallet_assembly_members m " +
        "JOIN pallet_assembly_outbox o ON o.id = m.add_id WHERE m.pallet_id = ? AND m.host_id = ? " +
        `AND m.device_id = ? AND ${ACTIVE_MEMBER} AND (? IS NULL OR m.sscc IN (SELECT value FROM json_each(?))) ORDER BY o.seq`,
      [row.id, ...owner, row.accepted_members, row.accepted_members],
      memberRow,
    );
    return {
      id: row.id,
      product: productSchema.parse(JSON.parse(row.product)),
      boxes,
      openedAt: row.opened_at,
      closedAt: row.closed_at,
      sscc: row.sscc,
      label: row.label === null ? null : labelSchema.parse(JSON.parse(row.label)),
      labelVersion: row.label_version,
      isCorrection: row.label_version > 0,
      printState: row.print_state,
      printReason: row.print_reason,
      deferred: row.deferred === 1,
      cancelled: row.cancelled === 1,
      syncState: row.sync_state,
    };
  }

  async function get(id: string): Promise<PalletAssemblyPallet | null> {
    const [row] = await getRow(id);
    return row === undefined ? null : toPallet(row);
  }

  async function conflicts(): Promise<PalletAssemblyConflict[]> {
    const rows = await local.query(
      "SELECT o.pallet_id AS palletId, p.sscc AS palletSscc, o.box_sscc AS boxSscc, " +
        "CASE WHEN json_type(o.outcome_details, '$.palletSscc') = 'text' THEN o.outcome_details ->> 'palletSscc' END AS winningPalletSscc, " +
        "CASE WHEN json_type(o.outcome_details, '$.closeIssueId') = 'text' THEN o.outcome_details ->> 'closeIssueId' END AS closeIssueId, " +
        "coalesce(o.outcome_code, 'rejected') AS code, " +
        "o.acknowledged_at IS NOT NULL AS acknowledged, " +
        "o.kind IN ('warehouse_pallet_opened', 'warehouse_pallet_closed') AS blocksAssembly, " +
        "(o.kind = 'warehouse_pallet_opened' AND o.outcome = 'rejected' AND p.closed_at IS NULL AND p.abandoned_at IS NULL) AS canAbandon " +
        "FROM pallet_assembly_outbox o JOIN pallet_assembly_pallets p ON p.id = o.pallet_id " +
        "WHERE o.host_id = ? AND o.device_id = ? AND (o.outcome = 'rejected' OR o.replay_blocked = 1) AND o.resolved_at IS NULL " +
        "AND o.kind <> 'warehouse_pallet_label' ORDER BY o.seq DESC",
      owner,
      conflictRow,
    );
    return rows.map((row) => ({
      ...row,
      acknowledged: row.acknowledged === 1,
      blocksAssembly: row.blocksAssembly === 1,
      canAbandon: row.canAbandon === 1,
    }));
  }

  function bumpOpen(id: string, revision: number): LocalStatement {
    return {
      sql:
        "UPDATE pallet_assembly_pallets SET revision = revision + 1 WHERE id = ? AND host_id = ? " +
        "AND device_id = ? AND revision = ? AND closed_at IS NULL AND abandoned_at IS NULL " +
        `AND ${ASSEMBLY_OPERATOR} AND ${NOT_BLOCKED}`,
      values: [id, ...owner, revision, ...actor, ...owner],
      expectedChanges: 1,
    };
  }

  return {
    get,
    async read() {
      const [[open], pending, notices, registry] = await Promise.all([
        openRows(),
        select(
          "AND p.closed_at IS NOT NULL AND p.cancelled_at IS NULL AND p.print_state <> 'confirmed' ORDER BY p.closed_at DESC, p.id",
        ),
        conflicts(),
        readPalletRegistryState(local, pairing),
      ]);
      return {
        open: open === undefined ? null : await toPallet(open),
        pendingLabels: await Promise.all(pending.map(toPallet)),
        conflicts: notices,
        registrySyncedAt: registry?.syncedAt ?? null,
        canOpenPallets: registry?.canOpenPallets ?? null,
      };
    },
    async add(sscc) {
      if (!isValidSscc(sscc) || sscc.startsWith("1")) return { kind: "invalid_box_sscc" };
      if (!(await authorized())) return { kind: "forbidden" };
      if (!(await unblocked())) return { kind: "blocked" };
      const registry = await readPalletRegistryState(local, pairing);
      if (registry?.syncedAt == null) return { kind: "registry_required" };
      const [cached] = await local.query(
        "SELECT payload, refreshed_at FROM pallet_registry_boxes WHERE host_id = ? AND device_id = ? AND sscc = ?",
        [...owner, sscc],
        registryRow,
      );
      if (cached === undefined) return { kind: "unknown_box" };
      const box = boxRegistryItemSchema.parse(JSON.parse(cached.payload));
      if (box.kind === "remove") return { kind: "removed_box" };
      if (box.closedAt === undefined || box.productId === undefined) return { kind: "unknown_box" };
      const [existing] = await openRows();
      const open = existing === undefined ? null : await toPallet(existing);
      if (open?.boxes.some((member) => member.sscc === sscc) === true) return { kind: "duplicate" };
      const removedFromDraft =
        open !== null &&
        box.palletId === open.id &&
        (
          await local.query(
            "SELECT 1 AS n FROM pallet_assembly_outbox WHERE host_id = ? AND device_id = ? AND pallet_id = ? " +
              "AND box_sscc = ? AND kind = 'pallet_box_removed' AND outcome IS NOT 'rejected' LIMIT 1",
            [...owner, open.id, sscc],
            ownerRow,
          )
        ).length > 0;
      if (
        !removedFromDraft &&
        (box.palletActive === true || box.palletId !== undefined || box.palletSscc !== undefined)
      ) {
        return { kind: "occupied", palletSscc: box.palletSscc ?? null };
      }
      // A local close can still own the box while the mirror says free. A fresh
      // release after an accepted close (e.g. office disassembly) takes precedence.
      const [held] = await local.query(
        `SELECT p.sscc ${LOCALLY_OCCUPIED} LIMIT 1`,
        [...owner, sscc, cached.refreshed_at],
        occupiedRow,
      );
      if (held !== undefined) return { kind: "occupied", palletSscc: held.sscc };
      if (open !== null && open.boxes.length > 0 && open.product.id !== box.productId) {
        return { kind: "different_product" };
      }
      if (
        open !== null &&
        open.product.capacity !== null &&
        open.boxes.length >= open.product.capacity
      ) {
        return { kind: "full" };
      }

      const switchProduct = open !== null && open.product.id !== box.productId;
      const needsOpen = existing === undefined || switchProduct;
      if (needsOpen && registry.canOpenPallets !== true) return { kind: "forbidden" };
      const id = needsOpen ? newId() : existing.id;
      const time = at();
      const statements: LocalStatement[] = [];
      if (existing !== undefined) {
        statements.push(bumpOpen(existing.id, existing.revision));
        if (switchProduct) {
          statements.push({
            sql: "UPDATE pallet_assembly_pallets SET abandoned_at = ? WHERE id = ?",
            values: [time, existing.id],
            expectedChanges: 1,
          });
        }
      }
      if (needsOpen) {
        const [product] = await local.query(
          "SELECT id, name, print_name AS printName, gtin14, shelf_life_days AS shelfLifeDays, " +
            "pallet_box_capacity AS capacity, chz_group_code AS chzGroupCode FROM ref_products WHERE id = ?",
          [box.productId],
          productSchema,
        );
        if (product === undefined) return { kind: "unknown_product" };
        statements.push({
          sql:
            "INSERT INTO pallet_assembly_pallets (id, host_id, device_id, product, opened_at) " +
            `SELECT ?, ?, ?, ?, ? WHERE ${ASSEMBLY_OPERATOR} AND ${NOT_BLOCKED} AND EXISTS (SELECT 1 ` +
            "FROM pallet_registry_state WHERE host_id = ? AND device_id = ? AND can_open_pallets = 1) " +
            "AND NOT EXISTS (SELECT 1 FROM pallet_assembly_pallets WHERE host_id = ? AND device_id = ? " +
            "AND closed_at IS NULL AND abandoned_at IS NULL)",
          values: [
            id,
            ...owner,
            JSON.stringify(product),
            time,
            ...actor,
            ...owner,
            ...owner,
            ...owner,
          ],
          expectedChanges: 1,
        });
        statements.push(
          assemblyEvent(pairing, operatorId, newId(), id, "warehouse_pallet_opened", time, {
            palletId: id,
            productId: product.id,
            openedAt: time,
          }),
        );
      }
      const addId = newId();
      statements.push({
        sql:
          "INSERT INTO pallet_assembly_members (add_id, host_id, device_id, pallet_id, sscc, shift_number, production_date, item_count) " +
          "SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pallet_registry_boxes " +
          "WHERE host_id = ? AND device_id = ? AND sscc = ? AND payload = ?) " +
          "AND EXISTS (SELECT 1 FROM pallet_registry_state WHERE host_id = ? AND device_id = ? AND synced_at IS NOT NULL) " +
          `AND NOT EXISTS (SELECT 1 ${LOCALLY_OCCUPIED})`,
        values: [
          addId,
          ...owner,
          id,
          sscc,
          box.shiftNumber ?? null,
          box.productionDate ?? null,
          box.bottleCount ?? 0,
          ...owner,
          sscc,
          cached.payload,
          ...owner,
          ...owner,
          sscc,
          cached.refreshed_at,
        ],
        expectedChanges: 1,
      });
      statements.push(
        assemblyEvent(
          pairing,
          operatorId,
          addId,
          id,
          "pallet_box_added",
          time,
          { palletId: id, boxSscc: sscc, addedAt: time },
          sscc,
        ),
      );
      if (!(await applyAssemblyChange(local, statements))) return { kind: "stale" };
      const pallet = await get(id);
      if (pallet === null) return { kind: "stale" };
      return {
        kind: "added",
        pallet,
        full: pallet.product.capacity !== null && pallet.boxes.length >= pallet.product.capacity,
      };
    },
    async remove(palletId, sscc) {
      const [row] = await getRow(palletId);
      if (row === undefined) return false;
      const time = at();
      return applyAssemblyChange(local, [
        bumpOpen(palletId, row.revision),
        {
          sql:
            "UPDATE pallet_assembly_members SET removed_at = ? WHERE pallet_id = ? AND host_id = ? " +
            "AND device_id = ? AND sscc = ? AND removed_at IS NULL AND EXISTS (SELECT 1 " +
            "FROM pallet_assembly_outbox o WHERE o.id = pallet_assembly_members.add_id AND o.outcome IS NOT 'rejected')",
          values: [time, palletId, ...owner, sscc],
          expectedChanges: 1,
        },
        assemblyEvent(
          pairing,
          operatorId,
          newId(),
          palletId,
          "pallet_box_removed",
          time,
          { palletId, boxSscc: sscc, removedAt: time },
          sscc,
        ),
      ]);
    },
    async close(palletId, issuerPrefix, template, expectedBoxSsccs) {
      if (!(await authorized())) return { kind: "forbidden" };
      if (!(await unblocked())) return { kind: "blocked" };
      const [row] = await getRow(palletId);
      if (row === undefined || row.closed_at !== null) return { kind: "stale" };
      const pallet = await toPallet(row);
      if (
        expectedBoxSsccs !== undefined &&
        (pallet.boxes.length !== expectedBoxSsccs.length ||
          pallet.boxes.some(({ sscc }, index) => sscc !== expectedBoxSsccs[index]))
      )
        return { kind: "stale" };
      if (pallet.boxes.length === 0) return { kind: "empty" };
      const [block] = await local.query(
        "SELECT block_id, next_serial FROM floor_sscc_blocks WHERE host_id = ? AND device_id = ? " +
          "AND issuer_prefix = ? AND extension = 1 AND next_serial <= to_serial ORDER BY from_serial, block_id LIMIT 1",
        [...owner, issuerPrefix],
        blockRow,
      );
      if (block === undefined) return { kind: "no_serials" };
      const serial = block.next_serial;
      const time = at();
      const spend = {
        sql: "UPDATE floor_sscc_blocks SET next_serial = next_serial + 1 WHERE block_id = ? AND next_serial = ?",
        values: [block.block_id, serial],
        expectedChanges: 1,
      };
      let sscc: string | null;
      try {
        sscc = buildSscc(1, issuerPrefix, serial);
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "SSCC_RANGE")) throw error;
        sscc = null;
      }
      if (sscc !== null) {
        const held = await local.query(PALLET_SSCC_HELD_SQL, [sscc, sscc], ownerRow);
        if (held.length > 0) sscc = null;
      }
      if (sscc === null) {
        const changed = await applyAssemblyChange(local, [bumpOpen(palletId, row.revision), spend]);
        return { kind: changed ? "invalid_serial" : "stale" };
      }
      const firstDate = pallet.boxes[0]?.productionDate ?? null;
      const label = {
        template,
        boxCount: pallet.boxes.length,
        itemCount: pallet.boxes.reduce((total, box) => total + box.itemCount, 0),
        productionDate: pallet.boxes.every((box) => box.productionDate === firstDate)
          ? firstDate
          : null,
      };
      const changed = await applyAssemblyChange(local, [
        bumpOpen(palletId, row.revision),
        spend,
        {
          sql:
            "UPDATE pallet_assembly_pallets SET closed_at = ?, sscc = ?, label = ? WHERE id = ? " +
            "AND NOT EXISTS (SELECT 1 FROM floor_pallets WHERE sscc = ?) " +
            "AND NOT EXISTS (SELECT 1 FROM pallet_assembly_pallets WHERE sscc = ?)",
          values: [time, sscc, JSON.stringify(label), palletId, sscc, sscc],
          expectedChanges: 1,
        },
        assemblyEvent(pairing, operatorId, newId(), palletId, "warehouse_pallet_closed", time, {
          palletId,
          sscc,
          blockId: block.block_id,
          serial,
          openedAt: pallet.openedAt,
          closedAt: time,
          boxCount: label.boxCount,
        }),
      ]);
      if (!changed) return { kind: "stale" };
      const closed = await get(palletId);
      return closed === null ? { kind: "stale" } : { kind: "closed", pallet: closed };
    },
    ...createAssemblyPrintStore({ local, pairing, operatorId, now, newId }),
    async acknowledgeConflict(palletId) {
      await local.transaction([
        {
          sql:
            "UPDATE pallet_assembly_outbox SET acknowledged_at = ? WHERE pallet_id = ? AND host_id = ? " +
            `AND device_id = ? AND outcome = 'rejected' AND acknowledged_at IS NULL AND ${ASSEMBLY_OPERATOR}`,
          values: [at(), palletId, ...owner, ...actor],
        },
      ]);
    },
    async abandonOpenConflict(palletId) {
      const time = at();
      return applyAssemblyChange(local, [
        {
          sql:
            "UPDATE pallet_assembly_pallets SET abandoned_at = ?, revision = revision + 1 WHERE id = ? " +
            "AND host_id = ? AND device_id = ? AND abandoned_at IS NULL AND closed_at IS NULL " +
            "AND EXISTS (SELECT 1 FROM pallet_assembly_outbox o WHERE o.pallet_id = pallet_assembly_pallets.id " +
            "AND o.kind = 'warehouse_pallet_opened' AND o.outcome = 'rejected' AND o.resolved_at IS NULL) " +
            `AND ${ASSEMBLY_OPERATOR}`,
          values: [time, palletId, ...owner, ...actor],
          expectedChanges: 1,
        },
        {
          sql:
            "UPDATE pallet_assembly_members SET removed_at = ? WHERE pallet_id = ? AND host_id = ? " +
            "AND device_id = ? AND removed_at IS NULL",
          values: [time, palletId, ...owner],
        },
        {
          sql:
            "UPDATE pallet_assembly_outbox SET acked_at = ?, outcome = 'rejected', outcome_code = 'draft_abandoned' " +
            "WHERE pallet_id = ? AND host_id = ? AND device_id = ? AND acked_at IS NULL",
          values: [time, palletId, ...owner],
        },
        {
          sql:
            "UPDATE pallet_assembly_outbox SET resolved_at = ? WHERE pallet_id = ? AND host_id = ? " +
            "AND device_id = ? AND outcome = 'rejected' AND resolved_at IS NULL",
          values: [time, palletId, ...owner],
        },
      ]);
    },
  };
}
