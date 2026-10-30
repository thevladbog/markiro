import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const loadModule = createRequire(import.meta.url);
function rejected() {
  return new Error("bootstrap guard rejected");
}
async function directory(root) {
  const s = await fs.lstat(root);
  if (
    !s.isDirectory() ||
    s.uid !== process.getuid() ||
    (s.mode & 0o7777) !== 0o700 ||
    (await fs.realpath(root)) !== resolve(root)
  )
    throw rejected();
}
async function readPrivate(path, mode) {
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== mode ||
      before.size > 1048576
    )
      throw rejected();
    const bytes = await file.readFile(),
      after = await file.stat();
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw rejected();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await file.close();
  }
}
async function exclusiveJson(root, name, value) {
  await directory(root);
  const temporary = join(root, `${name}.${randomUUID()}.tmp`),
    destination = join(root, name);
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  await fs.link(temporary, destination);
  await fs.unlink(temporary);
  const dir = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export function filesystemGuard(root) {
  let sequence = 0,
    busy = false;
  return async (binding) => {
    if (!binding || busy || sequence >= 256) throw rejected();
    busy = true;
    const current = ++sequence,
      nonce = randomUUID();
    try {
      await exclusiveJson(root, `${current}.request.json`, {
        schema: 1,
        sequence: current,
        nonce,
        binding,
      });
      for (;;) {
        await directory(root);
        let reply;
        try {
          reply = await readPrivate(join(root, `${current}.reply.json`), 0o400);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        if (
          !isDeepStrictEqual(Object.keys(reply).sort(), [
            "approved",
            "binding",
            "nonce",
            "schema",
            "sequence",
          ]) ||
          reply.schema !== 1 ||
          reply.sequence !== current ||
          reply.nonce !== nonce ||
          reply.approved !== true ||
          !isDeepStrictEqual(reply.binding, binding)
        )
          throw rejected();
        return;
      }
    } finally {
      busy = false;
    }
  };
}
export async function probeBootstrapDatabase(pool, databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    url.searchParams.get("sslmode") !== "verify-full" ||
    url.searchParams.get("sslrootcert") !== "/run/markiro-postgres/ca.crt"
  )
    throw rejected();
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SELECT 1");
  } finally {
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  }
}
async function main() {
  const prefix = "/app/dist/modules/release-catalog/";
  const { configureCatalog } = loadModule(prefix + "catalog-config.js");
  const { S3CatalogStore } = loadModule(prefix + "catalog-store.js");
  const { CatalogLedger } = loadModule(prefix + "catalog-ledger.js");
  const { VerifiedCache } = loadModule(prefix + "catalog-cache.js");
  const { CatalogReadBootstrapOperator } = loadModule(prefix + "catalog-bootstrap.js");
  const { PlatformAuditService } = loadModule("/app/dist/platform-auth/platform-audit.service.js");
  const { createDb } = loadModule("/app/node_modules/@markiro/db");
  const root = "/bootstrap/rpc";
  let pool, store;
  try {
    if (
      process.env.SERVER_PROFILE !== "platform-only" ||
      process.env.RELEASE_CATALOG_WRITERS_ENABLED !== "false"
    )
      throw rejected();
    const config = configureCatalog(process.env);
    if (!config || config.bucket !== "markiro-releases") throw rejected();
    const input = await readPrivate("/bootstrap/input.json", 0o400);
    const database = createDb(process.env.DATABASE_URL, { max: 1 });
    pool = database.pool;
    await probeBootstrapDatabase(pool, process.env.DATABASE_URL);
    store = new S3CatalogStore(config);
    const guard = filesystemGuard(root);
    let binding;
    const operator = new CatalogReadBootstrapOperator({
      db: database.db,
      bucket: config.bucket,
      cache: new VerifiedCache(config, store),
      audit: new PlatformAuditService(),
      ledger: new CatalogLedger(
        { ...config, maxPages: 100, maxRecords: 10000, maxBytes: 67108864 },
        store,
      ),
      authorize: async (value) => {
        binding = value;
        await guard(binding);
      },
      assertFenced: async () => {
        await guard(binding);
      },
    });
    const result = await operator.apply(input);
    await exclusiveJson(root, "result.json", { schema: 1, result });
  } catch {
    // No SQL, storage body, credentials, exception message or argv crosses stdout/stderr.
    process.stderr.write("Read-only catalog bootstrap failed; retain operation evidence.\n");
    process.exitCode = 1;
  } finally {
    store?.destroy();
    await pool?.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    process.exitCode = 1;
  });
