import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { receiptBytes } from "../src/modules/release-catalog/catalog-ledger";
import { scanRecovery } from "../src/modules/release-catalog/catalog-recovery";
import { digest, fakeLedgerStore, publicationOperation } from "./support/catalog-ledger";
async function fixture(operations: unknown[]) {
  const f = fakeLedgerStore();
  const inventory: { id: string; sha256: string }[] = [];
  for (const op of operations) {
    const bytes = receiptBytes(op),
      parsed = JSON.parse(bytes.toString()) as { id: string };
    await f.store.writeReceipt(parsed.id, bytes);
    inventory.push({ id: parsed.id, sha256: digest(bytes) });
  }
  return {
    ...f,
    input: {
      bucket: "markiro-releases",
      writersFenced: true,
      independentInventoryComplete: true,
      independentInventory: inventory,
      technicalKeys: [],
      maxPages: 20,
      maxRecords: 100,
      maxBytes: 1048576,
      timeoutMs: 1000,
    },
  };
}
function channel(target: string) {
  const body = Buffer.from('{"version":"1.0.0"}');
  return {
    schema: 1,
    id: randomUUID(),
    kind: "channel",
    epoch: randomUUID(),
    identity: { product: "standalone", channel: "stable" },
    expectedRevision: "0",
    revision: "1",
    previousPublicationId: null,
    publicationId: target,
    transition: "forward",
    pointer: {
      base64: body.toString("base64"),
      sha256: digest(body),
      sizeBytes: body.length,
      contentType: "application/json",
    },
  };
}
function confirm(op: unknown, id: string, result: unknown) {
  return {
    schema: 1,
    id: randomUUID(),
    kind: "confirmation",
    preparedId: id,
    preparedSha256: digest(receiptBytes(op)),
    result,
  };
}
describe("fenced complete-ledger recovery", () => {
  it("reserves prepared paths but does not claim unconfirmed publication or pointer commit", async () => {
    const p = publicationOperation(),
      c = channel(randomUUID()),
      f = await fixture([p, c]);
    const plan = await scanRecovery(f.store, f.input);
    expect(plan.reservedPublications).toHaveLength(1);
    expect(plan.publications).toHaveLength(0);
    expect(plan.channels).toEqual([
      expect.objectContaining({ readable: false, reason: "unconfirmed_channel" }),
    ]);
    expect(plan.writersMayEnable).toBe(false);
  });
  it("recovers only a corroborated contiguous channel chain and exact bindings", async () => {
    const p = publicationOperation(),
      id = randomUUID(),
      c = channel(id),
      f = await fixture([
        p,
        confirm(p, p.id, { kind: "publication", publicationId: id }),
        c,
        confirm(c, c.id, { kind: "channel", publicationId: id, revision: "1" }),
      ]);
    const plan = await scanRecovery(f.store, f.input);
    expect(plan.publications).toHaveLength(1);
    expect(plan.channels).toEqual([
      expect.objectContaining({ revision: "1", publicationId: id, readable: true }),
    ]);
    expect(plan.publications[0]?.operation.files[0]?.versionId).toBe("original");
    expect(plan.writersMayEnable).toBe(false);
  });
  it("deduplicates equal physical receipt versions without selecting current head", async () => {
    const p = publicationOperation(),
      f = await fixture([p]);
    await f.store.writeReceipt(p.id, receiptBytes(p));
    const plan = await scanRecovery(f.store, f.input);
    expect(plan.reservedPublications).toHaveLength(1);
  });
  it("fails closed for a changed binding under the same path", async () => {
    const p = publicationOperation(),
      q = {
        ...p,
        id: randomUUID(),
        files: p.files.map((file) => ({ ...file, versionId: "other" })),
      },
      f = await fixture([p, q]);
    await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
  });
  it("rejects a second complete set even if it repeats the same claimed digest", async () => {
    const p = publicationOperation(),
      file = p.files[0];
    if (!file) throw new Error("fixture");
    const q = {
      ...p,
      id: randomUUID(),
      files: [
        ...p.files,
        {
          ...file,
          publicPath: "/standalone/stable/1.0.0/extra.exe",
          key: "standalone/history/extra.exe",
        },
      ],
    };
    const f = await fixture([p, q]);
    await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
  });
  it("bounds an unresponsive version listing", async () => {
    const f = await fixture([]);
    f.store.listReceiptVersions = async () => new Promise(() => {});
    await expect(scanRecovery(f.store, { ...f.input, timeoutMs: 50 })).rejects.toThrow();
  }, 500);
  it("bounds the entire scan rather than restarting its budget per receipt", async () => {
    const p = publicationOperation(),
      q = {
        ...publicationOperation(),
        identity: { product: "standalone", channel: "stable", version: "2.0.0" },
        files: publicationOperation().files.map((f) => ({
          ...f,
          publicPath: "/standalone/stable/2.0.0/app.exe",
        })),
      };
    const f = await fixture([p, q]),
      read = f.store.readVersion;
    f.store.readVersion = async (target, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return read(target, signal);
    };
    await expect(scanRecovery(f.store, { ...f.input, timeoutMs: 60 })).rejects.toThrow();
  });
  it("does not accept complete S3 enumeration as independent evidence of no deletion", async () => {
    const f = await fixture([publicationOperation()]);
    for (const patch of [
      { writersFenced: false },
      { independentInventoryComplete: false },
      { independentInventory: [] },
    ])
      await expect(scanRecovery(f.store, { ...f.input, ...patch })).rejects.toThrow();
    f.versions.clear();
    await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
  });
  it("rejects deleted, malformed, unknown and same-key conflicting receipts", async () => {
    for (const mode of ["deleted", "malformed", "unknown", "conflict"]) {
      const p = publicationOperation(),
        f = await fixture([p]);
      const r = [...f.versions.values()][0];
      if (!r) throw new Error("fixture absent");
      if (mode === "deleted") r.deleted = true;
      if (mode === "malformed") r.bytes = Buffer.from("{}");
      if (mode === "unknown") {
        f.versions.clear();
        f.versions.set("other", { ...r, key: "_publication-ledger/unrecognized.json" });
      }
      if (mode === "conflict") {
        f.versions.set("other", {
          ...r,
          versionId: "v2",
          bytes: receiptBytes({ ...p, sourceSha: "d".repeat(40) }),
        });
      }
      await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
    }
  });
  it("rejects duplicate/nonprogressing pagination and enforces total limits", async () => {
    const p = publicationOperation(),
      f = await fixture([p]);
    const page = await f.store.listReceiptVersions();
    f.store.listReceiptVersions = async () => ({
      ...page,
      nextCursor: { key: `_publication-ledger/${p.id}.json`, versionId: "v1" },
    });
    await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
    const g = await fixture([p]);
    await expect(scanRecovery(g.store, { ...g.input, maxBytes: 1 })).rejects.toThrow();
  });
  it("preserves path, version, range and closed reservations across all pages", async () => {
    const p = publicationOperation(),
      r = {
        schema: 1,
        id: randomUUID(),
        kind: "reservation",
        epoch: p.epoch,
        identity: { product: "standalone", channel: "stable" },
        evidenceSha256: "e".repeat(64),
        entries: [
          { kind: "path", version: "0.9.0", publicPath: "/standalone/stable/0.9.0/app.exe" },
          { kind: "version", version: "0.8.0" },
          { kind: "range", upperBound: "0.7.0" },
          { kind: "closed" },
        ],
      };
    const f = await fixture([p, r]),
      page = await f.store.listReceiptVersions();
    let calls = 0;
    f.store.listReceiptVersions = async (cursor) => {
      calls++;
      return cursor
        ? { versions: page.versions.slice(1), nextCursor: undefined }
        : {
            versions: page.versions.slice(0, 1),
            nextCursor: { key: `_publication-ledger/${p.id}.json`, versionId: "v1" },
          };
    };
    const plan = await scanRecovery(f.store, f.input);
    expect(calls).toBe(2);
    expect(plan.reservations[0]?.operation.entries).toEqual(r.entries);
  });
  it("blocks a confirmed but discontinuous channel chain and rejects orphan confirmation", async () => {
    const p = publicationOperation(),
      id = randomUUID(),
      c = { ...channel(id), expectedRevision: "2", revision: "3", previousPublicationId: id };
    const f = await fixture([
      p,
      confirm(p, p.id, { kind: "publication", publicationId: id }),
      c,
      confirm(c, c.id, { kind: "channel", publicationId: id, revision: "3" }),
    ]);
    expect((await scanRecovery(f.store, f.input)).channels).toMatchObject([
      { readable: false, reason: "inconsistent_channel_chain", pointer: null },
    ]);
    const g = await fixture([confirm(p, p.id, { kind: "publication", publicationId: id })]);
    await expect(scanRecovery(g.store, g.input)).rejects.toThrow();
  });
  it("excludes only individually allowlisted readiness probe keys", async () => {
    const f = await fixture([]),
      key = `_publication-ledger/_storage-readiness/${randomUUID()}.txt`;
    f.versions.set("probe", {
      key,
      versionId: "probe-v1",
      bytes: Buffer.from("probe"),
      deleted: false,
    });
    await expect(scanRecovery(f.store, f.input)).rejects.toThrow();
    expect(
      (await scanRecovery(f.store, { ...f.input, technicalKeys: [key] })).reservedPublications,
    ).toEqual([]);
  });
});
