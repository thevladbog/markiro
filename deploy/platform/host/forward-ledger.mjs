import { canonical, digest, ensure, keys, plain } from "../backup/schemas.mjs";
import { createDockerCommand } from "./observe.mjs";
import { upgradeSchemaQuery } from "./upgrade-schema.mjs";

const proofs = new WeakSet();
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const freeze = (value) => {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
export function productMigrationPaths(bytes) {
  ensure(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024);
  const journal = plain(JSON.parse(bytes.toString("utf8")));
  keys(journal, ["version", "dialect", "entries"]);
  ensure(
    journal.version === "7" &&
      journal.dialect === "postgresql" &&
      Array.isArray(journal.entries) &&
      journal.entries.length > 0 &&
      journal.entries.length <= 4096,
  );
  let previous = 0;
  const paths = journal.entries.map((entry, idx) => {
    keys(entry, ["idx", "version", "when", "tag", "breakpoints"]);
    ensure(
      entry.idx === idx &&
        entry.version === "7" &&
        typeof entry.breakpoints === "boolean" &&
        Number.isSafeInteger(entry.when) &&
        entry.when > previous &&
        typeof entry.tag === "string" &&
        /^[0-9]{4}_[a-z0-9_-]{1,100}$/u.test(entry.tag),
    );
    previous = entry.when;
    return `${entry.tag}.sql`;
  });
  ensure(new Set(paths).size === paths.length);
  return paths;
}
export function buildProductMigrationProof(input) {
  keys(input, ["productSha", "imageId", "imageReference", "files"]);
  const { productSha, imageId, imageReference, files } = input;
  ensure(typeof productSha === "string" && /^[a-f0-9]{40}$/u.test(productSha));
  ensure(typeof imageId === "string" && /^sha256:[a-f0-9]{64}$/u.test(imageId));
  ensure(
    typeof imageReference === "string" &&
      /^ghcr\.io\/thevladbog\/markiro-api@sha256:[a-f0-9]{64}$/u.test(imageReference),
  );
  ensure(Array.isArray(files) && files.length >= 2 && files.length <= 4097);
  const byPath = new Map();
  let total = 0;
  for (const file of files) {
    keys(file, ["path", "bytes"]);
    ensure(
      typeof file.path === "string" &&
        (file.path === "meta/_journal.json" ||
          /^[0-9]{4}_[a-z0-9_-]{1,100}\.sql$/u.test(file.path)),
    );
    ensure(
      Buffer.isBuffer(file.bytes) && file.bytes.length > 0 && file.bytes.length <= 2 * 1024 * 1024,
    );
    total += file.bytes.length;
    ensure(total <= 16 * 1024 * 1024 && !byPath.has(file.path));
    byPath.set(file.path, file.bytes);
  }
  ensure(byPath.has("meta/_journal.json"));
  productMigrationPaths(byPath.get("meta/_journal.json"));
  const journal = plain(JSON.parse(byPath.get("meta/_journal.json").toString("utf8")));
  keys(journal, ["version", "dialect", "entries"]);
  ensure(
    journal.version === "7" &&
      journal.dialect === "postgresql" &&
      Array.isArray(journal.entries) &&
      journal.entries.length === files.length - 1,
  );
  let previous = 0;
  const entries = journal.entries.map((entry, idx) => {
    keys(entry, ["idx", "version", "when", "tag", "breakpoints"]);
    ensure(
      entry.idx === idx &&
        entry.version === "7" &&
        typeof entry.breakpoints === "boolean" &&
        Number.isSafeInteger(entry.when) &&
        entry.when > previous &&
        typeof entry.tag === "string" &&
        /^[0-9]{4}_[a-z0-9_-]{1,100}$/u.test(entry.tag),
    );
    previous = entry.when;
    const bytes = byPath.get(`${entry.tag}.sql`);
    ensure(Buffer.isBuffer(bytes));
    return { idx, tag: entry.tag, hash: digest(bytes), createdAt: String(entry.when) };
  });
  ensure(
    new Set(entries.map((e) => e.tag)).size === entries.length &&
      new Set(entries.map((e) => e.hash)).size === entries.length,
  );
  const base = {
    version: 1,
    kind: "platform-product-migration-proof",
    productSha,
    imageId,
    imageReference,
    journalSha256: digest(byPath.get("meta/_journal.json")),
    files: [...byPath]
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([path, bytes]) => ({ path, sha256: digest(bytes) })),
    entries,
  };
  const proof = freeze({ ...base, proofSha256: digest(canonical(base)) });
  proofs.add(proof);
  return proof;
}
export function validateProductMigrationLedger(rows, proof) {
  // A JSON claim from an operator is not a product proof. Runtime constructs it
  // afresh from the pinned, independently inspected image before each phase.
  ensure(proof && proofs.has(proof));
  const actual = plain(rows);
  ensure(Array.isArray(actual) && actual.length === proof.entries.length);
  actual.forEach((row, idx) => {
    keys(row, ["hash", "createdAt"]);
    ensure(
      hash(row.hash) &&
        row.hash === proof.entries[idx].hash &&
        row.createdAt === proof.entries[idx].createdAt,
    );
  });
  return freeze(actual);
}
export const forwardMigrationQuery = `SELECT jsonb_build_object(
 'schema', (${upgradeSchemaQuery}),
 'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('hash',hash,'createdAt',created_at::text) ORDER BY created_at,id),'[]'::jsonb) FROM drizzle.__drizzle_migrations)
)`;
export async function observeForwardMigrationLedger({ postgresId, proof, root, runProcess }) {
  ensure(typeof postgresId === "string" && hash(postgresId) && proof && proofs.has(proof));
  const command = createDockerCommand({ root, dockerConfig: `${root}/docker` }, runProcess);
  const result = await command([
    "exec",
    "--user",
    "70:70",
    "--env",
    "PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=3000",
    "--env",
    "PGCONNECT_TIMEOUT=10",
    postgresId,
    "psql",
    "-X",
    "--no-password",
    "--username",
    "postgres",
    "--dbname",
    "markiro",
    "--tuples-only",
    "--no-align",
    "--command",
    forwardMigrationQuery,
  ]);
  const value = plain(JSON.parse(String(result.stdout)));
  keys(value, ["schema", "rows"]);
  keys(value.schema, ["systemId", "schemaSha256", "migrationSha256", "migrationCount"]);
  ensure(
    typeof value.schema.systemId === "string" &&
      /^[1-9][0-9]{0,19}$/u.test(value.schema.systemId) &&
      hash(value.schema.schemaSha256) &&
      hash(value.schema.migrationSha256) &&
      value.schema.migrationCount === String(proof.entries.length),
  );
  const rows = validateProductMigrationLedger(value.rows, proof);
  return freeze({
    version: 1,
    kind: "platform-forward-migration-observation",
    postgresId,
    productProofSha256: proof.proofSha256,
    schema: value.schema,
    rows,
  });
}
