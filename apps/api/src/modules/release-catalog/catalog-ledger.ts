import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  releaseOperationIdSchema,
  releaseSha256Schema,
  releaseVersionIdSchema,
} from "@markiro/platform-contracts";
import { z } from "zod";
import {
  checkLimits,
  scanDeadline,
  committedResultSchema,
  digest,
  enumerateVersions,
  MAX_RECEIPT_BYTES,
  parseReceipt,
  pinnedBytes,
  receiptBytes,
  type ScanLimits,
} from "./catalog-receipts";
import type { CatalogStore } from "./catalog-store";
import { CatalogFault, type VerifiedReceipt } from "./catalog-types";
export { receiptBytes } from "./catalog-receipts";
interface LedgerConfig extends ScanLimits {
  journalDir: string;
  bucket: string;
}
interface LedgerIO {
  syncFile(file: FileHandle): Promise<void>;
  syncDirectory(file: FileHandle): Promise<void>;
}
const proofSchema = z
  .object({
    operationId: releaseOperationIdSchema,
    sha256: releaseSha256Schema,
    ledgerKey: z.string(),
    ledgerVersionId: releaseVersionIdSchema,
  })
  .strict()
  .refine((r) => r.ledgerKey === `_publication-ledger/${r.operationId}.json`);
function code(e: unknown) {
  return e && typeof e === "object" && "code" in e ? e.code : undefined;
}
/** Resolve only a canonical direct journal entry beneath the private directory. */
export function catalogJournalPath(root: string, name: string): string {
  const match = /^([a-f0-9-]{36})(?:\.attempt|\.stored)?\.json$/.exec(name);
  if (!match || !releaseOperationIdSchema.safeParse(match[1]).success)
    throw new CatalogFault("invalid_request");
  const directory = resolve(root);
  const path = resolve(directory, name);
  if (!path.startsWith(directory + sep) || dirname(path) !== directory)
    throw new CatalogFault("invalid_request");
  return path;
}
export class CatalogLedger {
  private readonly io: LedgerIO;
  constructor(
    private readonly config: LedgerConfig,
    private readonly store: CatalogStore,
    io: Partial<LedgerIO> = {},
  ) {
    checkLimits(config);
    this.io = {
      syncFile: async (f) => {
        await f.sync();
      },
      syncDirectory: async (f) => {
        await f.sync();
      },
      ...io,
    };
  }
  private async directory() {
    const s = await lstat(this.config.journalDir);
    if (
      !s.isDirectory() ||
      s.uid !== process.getuid?.() ||
      (s.mode & 0o777) !== 0o700 ||
      (await realpath(this.config.journalDir)) !== resolve(this.config.journalDir)
    )
      throw new CatalogFault("not_ready");
  }
  private async syncDirectory() {
    const f = await open(
      this.config.journalDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await this.io.syncDirectory(f);
    } finally {
      await f.close();
    }
  }
  private async read(name: string): Promise<Buffer> {
    await this.directory();
    const f = await open(
      catalogJournalPath(this.config.journalDir, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const before = await f.stat();
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o777) !== 0o600 ||
        before.nlink !== 1 ||
        before.size > MAX_RECEIPT_BYTES
      )
        throw new CatalogFault("not_ready");
      const bytes = await f.readFile();
      const after = await f.stat();
      if (
        bytes.length !== before.size ||
        after.size !== before.size ||
        after.ctimeMs !== before.ctimeMs ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new CatalogFault("not_ready");
      return bytes;
    } finally {
      await f.close();
    }
  }
  /** Never delete or rewrite a receipt after a partial failure. */
  private async persist(name: string, bytes: Buffer): Promise<boolean> {
    await this.directory();
    let created = true,
      file: FileHandle;
    try {
      file = await open(catalogJournalPath(this.config.journalDir, name), "wx", 0o600);
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      created = false;
      if (!(await this.read(name)).equals(bytes)) throw new CatalogFault("conflict");
      file = await open(
        catalogJournalPath(this.config.journalDir, name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    }
    try {
      if (created) await file.writeFile(bytes);
      await this.io.syncFile(file);
    } finally {
      await file.close();
    }
    await this.syncDirectory();
    return created;
  }
  async load(id: string) {
    if (!releaseOperationIdSchema.safeParse(id).success) throw new CatalogFault("invalid_request");
    const op = parseReceipt(await this.read(`${id}.json`));
    if (op.id !== id) throw new CatalogFault("not_ready");
    return op;
  }
  private async resolve(id: string, bytes: Buffer): Promise<VerifiedReceipt> {
    const remaining = scanDeadline(this.config.timeoutMs);
    const key = `_publication-ledger/${id}.json`,
      matches = (
        await enumerateVersions(this.store, { ...this.config, timeoutMs: remaining() })
      ).filter((v) => v.key === key);
    if (!matches.length || matches.some((v) => v.deleted)) throw new CatalogFault("unavailable");
    let total = 0;
    for (const v of matches) {
      const actual = await pinnedBytes(
        this.store,
        this.config.bucket,
        v,
        MAX_RECEIPT_BYTES,
        remaining(),
      );
      total += actual.length;
      if (total > this.config.maxBytes || !actual.equals(bytes))
        throw new CatalogFault("not_ready");
    }
    matches.sort((a, b) => (a.versionId < b.versionId ? -1 : a.versionId > b.versionId ? 1 : 0));
    const selected = matches[0];
    if (!selected) throw new CatalogFault("unavailable");
    return {
      operationId: id,
      sha256: digest(bytes),
      ledgerKey: key,
      ledgerVersionId: selected.versionId,
    };
  }
  async prepare(input: unknown): Promise<VerifiedReceipt> {
    const bytes = receiptBytes(input),
      op = parseReceipt(bytes);
    await this.persist(`${op.id}.json`, bytes);
    let saved: Buffer | undefined;
    try {
      saved = await this.read(`${op.id}.stored.json`);
    } catch (error) {
      if (code(error) !== "ENOENT") throw error;
    }
    if (saved) {
      let value: unknown;
      try {
        value = JSON.parse(saved.toString("utf8"));
      } catch {
        throw new CatalogFault("not_ready");
      }
      const result = proofSchema.safeParse(value);
      if (
        !result.success ||
        result.data.operationId !== op.id ||
        result.data.sha256 !== digest(bytes)
      )
        throw new CatalogFault("not_ready");
      const proof = result.data;
      await this.persist(`${op.id}.stored.json`, saved);
      if (
        !(
          await pinnedBytes(
            this.store,
            this.config.bucket,
            { key: proof.ledgerKey, versionId: proof.ledgerVersionId },
            MAX_RECEIPT_BYTES,
            this.config.timeoutMs,
          )
        ).equals(bytes)
      )
        throw new CatalogFault("not_ready");
      return proof;
    }
    const fresh = await this.persist(
      `${op.id}.attempt.json`,
      Buffer.from(JSON.stringify({ id: op.id, sha256: digest(bytes) })),
    );
    let proof: VerifiedReceipt;
    if (fresh) {
      try {
        const stored = await this.store.writeReceipt(op.id, bytes);
        const result = proofSchema.safeParse({
          operationId: op.id,
          sha256: digest(bytes),
          ledgerKey: stored.key,
          ledgerVersionId: stored.versionId,
        });
        if (!result.success) throw new CatalogFault("not_ready");
        proof = result.data;
      } catch {
        proof = await this.resolve(op.id, bytes);
      }
    } else proof = await this.resolve(op.id, bytes);
    await this.persist(`${op.id}.stored.json`, Buffer.from(JSON.stringify(proof)));
    return proof;
  }
  async confirmCommitted(preparedId: string, result: unknown): Promise<VerifiedReceipt> {
    const prepared = await this.load(preparedId),
      parsed = committedResultSchema.safeParse(result);
    if (
      !parsed.success ||
      (prepared.kind !== "publication" && prepared.kind !== "channel") ||
      parsed.data.kind !== prepared.kind
    )
      throw new CatalogFault("invalid_request");
    if (
      prepared.kind === "channel" &&
      (parsed.data.kind !== "channel" ||
        parsed.data.publicationId !== prepared.publicationId ||
        parsed.data.revision !== prepared.revision)
    )
      throw new CatalogFault("conflict");
    return this.prepare({
      schema: 1,
      id: randomUUID(),
      kind: "confirmation",
      preparedId,
      preparedSha256: digest(receiptBytes(prepared)),
      result: parsed.data,
    });
  }
}
