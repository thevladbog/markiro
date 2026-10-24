import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogLedger, receiptBytes } from "../src/modules/release-catalog/catalog-ledger";
import { digest, fakeLedgerStore, publicationOperation } from "./support/catalog-ledger";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), "catalog-ledger-"));
  roots.push(root);
  await chmod(root, 0o700);
  const f = fakeLedgerStore();
  return {
    ...f,
    root,
    config: {
      journalDir: root,
      bucket: "markiro-releases",
      maxPages: 20,
      maxRecords: 100,
      maxBytes: 1048576,
      timeoutMs: 1000,
    },
  };
}
describe("dual durable release ledger", () => {
  it("requires fsynced local bytes before S3, and resumes a local-only crash", async () => {
    const f = await fixture(),
      operation = publicationOperation();
    const failing = new CatalogLedger(f.config, f.store, {
      syncFile: async () => {
        throw new Error("fsync crash");
      },
    });
    await expect(failing.prepare(operation)).rejects.toThrow();
    expect(f.puts()).toBe(0);
    expect(await readFile(join(f.root, `${operation.id}.json`))).toEqual(receiptBytes(operation));
    const receipt = await new CatalogLedger(f.config, f.store).prepare(operation);
    expect(receipt.sha256).toBe(digest(receiptBytes(operation)));
    expect(f.puts()).toBe(1);
  });
  it("resolves a lost PUT response by exact-version readback, never by another PUT", async () => {
    const f = await fixture(),
      operation = publicationOperation(),
      put = f.store.writeReceipt;
    f.store.writeReceipt = async (id, bytes) => {
      await put(id, bytes);
      throw new Error("response lost");
    };
    const ledger = new CatalogLedger(f.config, f.store),
      first = await ledger.prepare(operation);
    expect(await ledger.prepare(operation)).toEqual(first);
    expect(f.puts()).toBe(1);
    expect(first.ledgerVersionId).toBe("v1");
  });
  it("does not repeat a write whose first outcome remains unknown", async () => {
    const f = await fixture(),
      operation = publicationOperation();
    let attempts = 0;
    f.store.writeReceipt = async () => {
      attempts++;
      throw new Error("unknown outcome");
    };
    const ledger = new CatalogLedger(f.config, f.store);
    await expect(ledger.prepare(operation)).rejects.toThrow();
    await expect(ledger.prepare(operation)).rejects.toThrow();
    expect(attempts).toBe(1);
  });
  it("resyncs a proof whose local fsync failed after verified S3 readback", async () => {
    const f = await fixture(),
      op = publicationOperation();
    let calls = 0;
    await expect(
      new CatalogLedger(f.config, f.store, {
        syncFile: async (file) => {
          calls++;
          if (calls === 3) throw new Error("ack crash");
          await file.sync();
        },
      }).prepare(op),
    ).rejects.toThrow();
    expect(f.puts()).toBe(1);
    let synced = 0;
    await new CatalogLedger(f.config, f.store, {
      syncFile: async (file) => {
        synced++;
        await file.sync();
      },
    }).prepare(op);
    expect(synced).toBe(2);
    expect(f.puts()).toBe(1);
  });
  it("retains conflicting local bytes and refuses a physical rebinding under one operation", async () => {
    const f = await fixture(),
      operation = publicationOperation(),
      ledger = new CatalogLedger(f.config, f.store);
    await ledger.prepare(operation);
    await expect(
      ledger.prepare({
        ...operation,
        files: operation.files.map((file) => ({ ...file, versionId: "replacement" })),
      }),
    ).rejects.toThrow();
    expect(await readFile(join(f.root, `${operation.id}.json`))).toEqual(receiptBytes(operation));
    expect(f.puts()).toBe(1);
  });
  it("refuses symlinks, partial files and unknown fields without sending secrets", async () => {
    const f = await fixture(),
      operation = publicationOperation(),
      outside = join(f.root, "untouched");
    await writeFile(outside, "old", { mode: 0o600 });
    await symlink(outside, join(f.root, `${operation.id}.json`));
    await expect(new CatalogLedger(f.config, f.store).prepare(operation)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("old");
    await expect(
      new CatalogLedger(f.config, f.store).prepare({ ...operation, secret: "fixture" }),
    ).rejects.toThrow();
    expect(f.puts()).toBe(0);
    const g = await fixture();
    await writeFile(join(g.root, `${operation.id}.json`), "{", { mode: 0o600 });
    await expect(new CatalogLedger(g.config, g.store).prepare(operation)).rejects.toThrow();
    expect(g.puts()).toBe(0);
  });
  it("records a separate post-commit confirmation without changing the prepare receipt", async () => {
    const f = await fixture(),
      operation = publicationOperation(),
      ledger = new CatalogLedger(f.config, f.store),
      prepared = await ledger.prepare(operation);
    const confirmed = await ledger.confirmCommitted(operation.id, {
      kind: "publication",
      publicationId: "d05e93bc-87c3-42f1-996f-dc6e22a00001",
    });
    expect(confirmed.operationId).not.toBe(prepared.operationId);
    expect(await ledger.load(operation.id)).toEqual(operation);
    const confirmation = await ledger.load(confirmed.operationId);
    expect(confirmation).toMatchObject({
      kind: "confirmation",
      preparedId: operation.id,
      preparedSha256: prepared.sha256,
    });
    expect((await readdir(f.root)).filter((p) => /^[a-f0-9-]{36}\.json$/.test(p))).toHaveLength(2);
  });
});
