/** Snapshot-bound, non-secret catalog evidence embedded in the encrypted inventory.
 * The existing 2 MiB inventory cap remains a hard failure, never a truncation.
 * Raw PostgreSQL row text preserves bigint revisions and matches table-byte hashes.
 */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonical, digest, ensure, keys, plain } from "./schemas.mjs";
export const catalogTables = Object.freeze(
  [
    "epochs",
    "receipts",
    "intents",
    "publications",
    "objects",
    "reservations",
    "channels",
    "channel_events",
    "oidc_bindings",
  ].map((n) => `release_catalog_${n}`),
);
const LIMIT = 2 * 1024 * 1024,
  MAX_ROWS = 10000;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha = /^[a-f0-9]{64}$/u;
const kinds = ["publication", "reservation", "channel", "confirmation"];
function tables(inventory) {
  const found = inventory.tables.filter(
    (t) => t.schema === "public" && t.name.startsWith("release_catalog_"),
  );
  ensure(
    found.length === 0 ||
      (found.length === catalogTables.length &&
        catalogTables.every((n) => found.some((t) => t.name === n))),
  );
  return found;
}
function stateCheck(state, inventory) {
  const expected = tables(inventory);
  ensure(Array.isArray(state) && state.length === expected.length);
  const names = new Set();
  let total = 0;
  for (const entry of state) {
    keys(entry, ["name", "rows"]);
    ensure(catalogTables.includes(entry.name) && !names.has(entry.name));
    names.add(entry.name);
    ensure(Array.isArray(entry.rows) && entry.rows.length <= MAX_ROWS);
    const hashes = [];
    for (const row of entry.rows) {
      ensure(typeof row === "string");
      total += Buffer.byteLength(row);
      ensure(total <= LIMIT);
      plain(JSON.parse(row));
      hashes.push(digest(row));
    }
    const t = expected.find((t) => t.name === entry.name);
    ensure(
      t &&
        t.count === String(entry.rows.length) &&
        t.sha256 ===
          digest(
            hashes
              .sort()
              .map((h) => h + "\n")
              .join(""),
          ),
    );
  }
  return state;
}
/** Called inside the exact pg_export_snapshot transaction used by pg_dump. */
export async function captureCatalogState(client, inventory) {
  const present = tables(inventory);
  if (!present.length) return undefined;
  const state = [];
  let bytes = 0;
  for (const name of catalogTables) {
    const table = present.find((t) => t.name === name);
    ensure(BigInt(table.count) <= BigInt(MAX_ROWS));
    const size = (
      await client.query(
        `SELECT coalesce(sum(octet_length(row_to_json(t)::text)),0)::text AS bytes FROM ONLY public."${name}" t`,
      )
    ).rows[0]?.bytes;
    ensure(
      typeof size === "string" && /^[0-9]+$/.test(size) && BigInt(size) <= BigInt(LIMIT - bytes),
    );
    const rows = (
      await client.query(
        `SELECT row_to_json(t)::text AS row FROM ONLY public."${name}" t ORDER BY row_to_json(t)::text COLLATE "C" LIMIT ${MAX_ROWS + 1}`,
      )
    ).rows.map((r) => r.row);
    for (const row of rows) {
      bytes += Buffer.byteLength(row);
      ensure(bytes <= LIMIT);
    }
    state.push({ name, rows });
  }
  return stateCheck(state, inventory);
}
function unchanged(a, b) {
  for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) ensure(a[key] === b[key]);
}
function meta(s, uid, directory = false) {
  ensure(
    (directory ? s.isDirectory() : s.isFile()) &&
      s.uid === uid &&
      (s.mode & 0o7777) === (directory ? 0o700 : 0o600) &&
      (directory || s.nlink === 1),
  );
}
/** Read-only. Root may read the API uid1000 journal; no chown, copying or cleanup. */
export async function captureCatalogJournal({ path, uid, optional = false }) {
  ensure(
    typeof path === "string" && resolve(path) === path && Number.isSafeInteger(uid) && uid >= 0,
  );
  let initial;
  try {
    initial = await lstat(path, { bigint: true });
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  }
  ensure((await realpath(path)) === path);
  meta(await lstat(path), uid, true);
  const names = (await readdir(path)).sort();
  ensure(names.length <= MAX_ROWS);
  const result = [];
  let total = 0;
  for (const name of names) {
    ensure(
      /^[a-f0-9-]{36}(?:\.attempt|\.stored)?\.json$/u.test(name) && uuid.test(name.slice(0, 36)),
    );
    const file = await open(
      join(path, name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await file.stat({ bigint: true });
      meta(await file.stat(), uid);
      ensure(before.size <= BigInt(LIMIT - total));
      const bytes = await file.readFile();
      total += bytes.length;
      ensure(total <= LIMIT && BigInt(bytes.length) === before.size);
      unchanged(before, await file.stat({ bigint: true }));
      unchanged(before, await lstat(join(path, name), { bigint: true }));
      result.push({
        name,
        sha256: digest(bytes),
        sizeBytes: bytes.length,
        base64: bytes.toString("base64"),
      });
    } finally {
      await file.close();
    }
  }
  unchanged(initial, await lstat(path, { bigint: true }));
  ensure(canonical(names) === canonical((await readdir(path)).sort()));
  return result;
}
export function validateCatalogBackup(bundle, inventory) {
  const expected = tables(inventory);
  if (bundle === undefined) {
    ensure(expected.length === 0);
    return undefined;
  }
  keys(bundle, ["schema", "state", "journal"]);
  ensure(bundle.schema === 1 && expected.length === catalogTables.length);
  stateCheck(bundle.state, inventory);
  ensure(
    Array.isArray(bundle.journal) &&
      bundle.journal.length <= MAX_ROWS &&
      Buffer.byteLength(canonical(bundle)) <= LIMIT,
  );
  const files = new Map();
  for (const f of bundle.journal) {
    keys(f, ["name", "sha256", "sizeBytes", "base64"]);
    ensure(
      typeof f.name === "string" &&
        /^[a-f0-9-]{36}(?:\.attempt|\.stored)?\.json$/u.test(f.name) &&
        uuid.test(f.name.slice(0, 36)) &&
        !files.has(f.name) &&
        sha.test(f.sha256) &&
        Number.isSafeInteger(f.sizeBytes) &&
        f.sizeBytes > 0 &&
        typeof f.base64 === "string",
    );
    const b = Buffer.from(f.base64, "base64");
    ensure(b.toString("base64") === f.base64 && b.length === f.sizeBytes && digest(b) === f.sha256);
    files.set(f.name, { bytes: b, value: plain(JSON.parse(b)) });
  }
  for (const [name, file] of files) {
    const id = name.slice(0, 36),
      v = file.value,
      receipt = files.get(`${id}.json`);
    ensure(
      receipt &&
        receipt.value.schema === 1 &&
        receipt.value.id === id &&
        kinds.includes(receipt.value.kind),
    );
    if (name.endsWith(".attempt.json")) {
      keys(v, ["id", "sha256"]);
      ensure(v.id === id && v.sha256 === digest(receipt.bytes));
    }
    if (name.endsWith(".stored.json")) {
      keys(v, ["operationId", "sha256", "ledgerKey", "ledgerVersionId"]);
      ensure(
        v.operationId === id &&
          v.sha256 === digest(receipt.bytes) &&
          v.ledgerKey === `_publication-ledger/${id}.json` &&
          typeof v.ledgerVersionId === "string" &&
          Buffer.byteLength(v.ledgerVersionId) <= 1024 &&
          v.ledgerVersionId.trim() !== "" &&
          v.ledgerVersionId.trim().toLowerCase() !== "null" &&
          !/[\p{Cc}]/u.test(v.ledgerVersionId),
      );
    }
  }
  for (const raw of bundle.state.find((t) => t.name === "release_catalog_receipts").rows) {
    const r = JSON.parse(raw),
      saved = files.get(`${r.id}.stored.json`)?.value,
      receipt = files.get(`${r.id}.json`);
    ensure(
      saved &&
        receipt &&
        saved.operationId === r.id &&
        saved.sha256 === r.sha256 &&
        saved.ledgerKey === r.ledger_key &&
        saved.ledgerVersionId === r.ledger_version_id &&
        receipt.value.kind === r.kind,
    );
  }
  return bundle;
}
