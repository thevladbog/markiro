/** Bounded cloud final-state history. No source values are used in an error or log. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, link, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fileChecksum } from "./canonical.mjs";

export const MAX_HISTORY_PART_ROWS = 5_000;
export const MAX_HISTORY_PART_BYTES = 4 * 1_048_576;
export const MAX_HISTORY_MANIFEST_BYTES = 1_048_576;
export const MAX_HISTORY_PARTS = 10_000;
const categories = ["shifts", "codes", "boxes", "items", "pallets", "owners"];
const counts = () => Object.fromEntries(categories.map((key) => [key, 0]));
const payload = () => Object.fromEntries(categories.map((key) => [key, []]));
const issue = (code) => new Error(`history_${code}`);
export function isCivilDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function defaultHistorySince(now) {
  const year = now.getUTCFullYear() - 1;
  const month = now.getUTCMonth();
  const day = Math.min(now.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate());
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
const uuid = (x) =>
  typeof x === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(x);
const string = (x) => typeof x === "string";
const boolean = (x) => typeof x === "boolean";
const integer = (x) => Number.isSafeInteger(x) && x >= 0;
const instant = (x) =>
  string(x) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(x) &&
  Number.isFinite(Date.parse(x));
const nullable = (test) => (x) => x === null || test(x);
const hash = (x) => string(x) && /^[0-9a-f]{64}$/u.test(x);
const gtin = (x) => string(x) && /^\d{14}$/u.test(x);
const specs = {
  shifts: {
    id: uuid,
    number: string,
    mode: (x) => ["aggregation", "validation"].includes(x),
    productionDate: nullable(isCivilDate),
    plannedDate: nullable(isCivilDate),
    openedAt: nullable(instant),
    closedAt: nullable(instant),
    productId: uuid,
    productName: nullable(string),
    gtin14: gtin,
    shelfLifeDays: nullable(integer),
    lineId: nullable(uuid),
    lineName: nullable(string),
    palletsEnabled: boolean,
    inWindow: boolean,
    createdFrom: (x) => ["admin", "station"].includes(x),
    numberMonthKey: string,
    numberSeq: integer,
    createdAt: instant,
    plannedQty: nullable(integer),
    boxCapacity: nullable(integer),
    palletBoxCapacity: nullable(integer),
    counterpartyId: nullable(uuid),
    counterpartyName: nullable(string),
    closeReason: nullable(string),
  },
  codes: {
    shiftId: uuid,
    hash,
    canonical: (x) => string(x) && x.length > 0,
    scannedAt: instant,
    gtin14: nullable(gtin),
    serial: nullable(string),
    flatOnly: boolean,
  },
  boxes: {
    id: uuid,
    shiftId: uuid,
    sscc: nullable(string),
    openedAt: instant,
    closedAt: nullable(instant),
    disassembledAt: nullable(instant),
    palletId: nullable(uuid),
  },
  items: { boxId: uuid, hash, addedAt: instant },
  pallets: {
    id: uuid,
    shiftId: nullable(uuid),
    kind: (x) => ["production", "warehouse"].includes(x),
    productId: nullable(uuid),
    productName: nullable(string),
    gtin14: nullable(gtin),
    shelfLifeDays: nullable(integer),
    sscc: nullable(string),
    openedAt: instant,
    closedAt: nullable(instant),
    disassembledAt: nullable(instant),
  },
  owners: { hash, shiftId: uuid, number: string, scannedAt: instant, boxId: nullable(uuid) },
};
function validObject(value, spec) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(spec).length &&
    Object.entries(spec).every(([key, test]) => test(value[key]))
  );
}
function metadata(value) {
  const snapshot =
    value && Object.hasOwn(value, "exportedAt") ? { exportedAt: instant, since: isCivilDate } : {};
  if (
    !validObject(value, {
      source: (x) =>
        validObject(x, {
          tenantId: (x) => string(x) && /^[A-Za-z0-9_-]{1,64}$/u.test(x),
          tenantName: string,
        }),
      organization: (x) =>
        validObject(x, { name: string, inn: nullable(string), gln: string, timeZone: string }),
      clean: boolean,
      ...snapshot,
    })
  )
    throw issue("metadata");
  if (!value.clean) throw issue("cloud_not_clean");
  return value;
}
async function writeBytes(handle, data) {
  const bytes = typeof data === "string" ? Buffer.from(data) : data;
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset);
    if (bytesWritten === 0) throw issue("write");
    offset += bytesWritten;
  }
}

/** At most one part and the bounded manifest in RAM; two owner-only spool files next to output. */
export async function writeHistory(path, rows, { exportedAt, since }) {
  if (!instant(exportedAt) || (since !== undefined && !isCivilDate(since))) throw issue("date");
  const token = randomUUID();
  const spoolPath = join(dirname(path), `.${basename(path)}.${token}.rows.partial`);
  const finalPath = join(dirname(path), `.${basename(path)}.${token}.partial`);
  let spool;
  let final;
  try {
    spool = await open(spoolPath, "wx", 0o600);
    let meta;
    let partPayload = payload();
    let rowCount = 0;
    // Exact serialized bytes: envelope plus the individual JSON rows and their commas.
    let partBytes = Buffer.byteLength(
      JSON.stringify({ index: 0, payload: partPayload, checksum: `sha256:${"0".repeat(64)}` }),
    );
    const parts = [];
    const totals = counts();
    async function flush() {
      if (parts.length >= MAX_HISTORY_PARTS) throw issue("parts_limit");
      const part = { index: parts.length, payload: partPayload };
      part.checksum = fileChecksum(part);
      const serialized = JSON.stringify(part);
      if (Buffer.byteLength(serialized) > MAX_HISTORY_PART_BYTES) throw issue("row_size");
      const partCounts = Object.fromEntries(
        categories.map((key) => [key, partPayload[key].length]),
      );
      parts.push({ index: part.index, checksum: part.checksum, counts: partCounts });
      // Check the actual bounded manifest on every addition, avoiding an unbounded part inventory.
      const preview = {
        format: "markiro-cloud-history",
        formatVersion: 1,
        exportedAt,
        since,
        source: meta.source,
        organization: meta.organization,
        counts: totals,
        parts,
        checksum: `sha256:${"0".repeat(64)}`,
      };
      if (Buffer.byteLength(JSON.stringify(preview)) > MAX_HISTORY_MANIFEST_BYTES)
        throw issue("manifest_size");
      await writeBytes(spool, `${serialized}\n`);
      partPayload = payload();
      rowCount = 0;
      partBytes = Buffer.byteLength(
        JSON.stringify({
          index: parts.length,
          payload: partPayload,
          checksum: `sha256:${"0".repeat(64)}`,
        }),
      );
    }
    for await (const record of rows) {
      if (meta === undefined) {
        if (
          record?.type === "error" &&
          [
            "source_missing",
            "cloud_not_clean",
            "missing_canonical",
            "dependency_not_closed",
            "ambiguous_owner_box",
          ].includes(record.value)
        )
          throw issue(record.value);
        if (record?.type !== "metadata") throw issue("metadata");
        meta = metadata(record.value);
        exportedAt = meta.exportedAt ?? exportedAt;
        since = meta.since ?? since ?? defaultHistorySince(new Date(exportedAt));
        continue;
      }
      const spec = specs[record?.type];
      if (!spec || !validObject(record.value, spec)) throw issue("row_shape");
      const bytes = Buffer.byteLength(JSON.stringify(record.value));
      let added = bytes + (partPayload[record.type].length > 0 ? 1 : 0);
      if (
        rowCount > 0 &&
        (rowCount === MAX_HISTORY_PART_ROWS || partBytes + added > MAX_HISTORY_PART_BYTES)
      ) {
        await flush();
        added = bytes;
      }
      if (partBytes + added > MAX_HISTORY_PART_BYTES) throw issue("row_size");
      partPayload[record.type].push(record.value);
      rowCount++;
      partBytes += added;
      totals[record.type]++;
      if (!Number.isSafeInteger(totals[record.type])) throw issue("count");
    }
    if (meta === undefined) throw issue("metadata");
    if (rowCount > 0 || parts.length === 0) await flush();
    const manifest = {
      format: "markiro-cloud-history",
      formatVersion: 1,
      exportedAt,
      since,
      source: meta.source,
      organization: meta.organization,
      counts: totals,
      parts,
    };
    manifest.checksum = fileChecksum(manifest);
    await spool.sync();
    await spool.close();
    spool = undefined;
    final = await open(finalPath, "wx", 0o600);
    await writeBytes(final, `${JSON.stringify(manifest)}\n`);
    for await (const chunk of createReadStream(spoolPath)) await writeBytes(final, chunk);
    await final.sync();
    await final.close();
    final = undefined;
    // Hard link publishes atomically and refuses collisions. A filesystem without links fails safely.
    await link(finalPath, path);
    return manifest;
  } finally {
    await spool?.close().catch(() => {});
    await final?.close().catch(() => {});
    await unlink(spoolPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
  }
}

/** Bounded psql lines; stderr is drained but never relayed because database errors may quote values. */
export async function* runHistoryPsql({ psql = "psql", tenantId, since, env = process.env }) {
  const sql = fileURLToPath(new URL("./history.sql", import.meta.url));
  const child = spawn(
    psql,
    [
      "-X",
      "-q",
      "-A",
      "-t",
      "-v",
      "ON_ERROR_STOP=1",
      "-v",
      "FETCH_COUNT=1000",
      "-v",
      `tenant_id=${tenantId}`,
      "-v",
      `history_since=${since ?? ""}`,
      "-f",
      sql,
    ],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.resume();
  const exited = new Promise((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", resolve);
  });
  let pending = Buffer.alloc(0);
  try {
    for await (const chunk of child.stdout) {
      let start = 0;
      for (let i = 0; i <= chunk.length; i++) {
        if (i < chunk.length && chunk[i] !== 10) continue;
        const next = chunk.subarray(start, i);
        if (pending.length + next.length > MAX_HISTORY_PART_BYTES) throw issue("row_size");
        pending = Buffer.concat([pending, next]);
        if (i < chunk.length) {
          if (pending.length) {
            let value;
            try {
              value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pending));
            } catch {
              throw issue("sql_json");
            }
            yield value;
          }
          pending = Buffer.alloc(0);
          start = i + 1;
        }
      }
    }
    if (pending.length) throw issue("sql_incomplete");
    if ((await exited) !== 0) throw issue("psql_failed");
  } finally {
    if (child.exitCode === null) child.kill();
    await exited;
  }
}
