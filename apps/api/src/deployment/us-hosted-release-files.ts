import { constants, lstatSync, readlinkSync, type BigIntStats } from "node:fs";
import { open, opendir } from "node:fs/promises";

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const FILE_BYTES = 32 * 1024 * 1024;
const TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;
const roots = [
  "apps/api/dist/",
  "packages/db/dist/",
  "packages/domain/dist/",
  "packages/platform-contracts/dist/",
  "apps/admin/dist-us/",
  "packages/db/migrations/",
];
const metadata = [
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "packages/db/package.json",
  "packages/domain/package.json",
  "packages/platform-contracts/package.json",
];
const controls = new Map([
  ["us-synthetic-api.json", 16_384],
  ["us-synthetic-worker.json", 16_384],
  ["us-synthetic-release.json", 1024 * 1024],
]);
const invalid = () => new Error("us_hosted_release_file_invalid");
function same(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
type Snapshot = Readonly<{
  bytes: Buffer;
  stat: BigIntStats;
  parents: ReadonlyArray<readonly [string, BigIntStats]>;
}>;

/** Fixed protected artifact acquisition only. Returned bytes grant no release authority. */
export class UsHostedReleaseFiles {
  readonly #topology = new Map<string, BigIntStats>();
  readonly #dependencyMetadata = new Set<string>();
  readonly #records = new Map<string, Snapshot>();
  readonly #gid: number;
  #total = 0;
  #reserved = 0;
  readonly #pending = new Set<string>();
  #disposed = false;
  constructor() {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!Number.isSafeInteger(uid) || uid === 0 || !Number.isSafeInteger(gid) || gid === undefined)
      throw invalid();
    this.#gid = gid;
  }
  #live(): void {
    if (this.#disposed) throw invalid();
  }
  #directory(stat: BigIntStats): void {
    if (!stat.isDirectory() || stat.uid !== 0n || (stat.mode & 0o022n) !== 0n) throw invalid();
  }
  #file(stat: BigIntStats, maximum: number): void {
    const mode = stat.mode & 0o777n;
    if (
      !stat.isFile() ||
      stat.uid !== 0n ||
      stat.size < 0n ||
      stat.size > BigInt(maximum) ||
      (mode !== 0o444n && !(mode === 0o440n && stat.gid === BigInt(this.#gid)))
    )
      throw invalid();
  }
  #path(relative: string, maximum: number): number {
    if (
      typeof relative !== "string" ||
      relative.length > 4096 ||
      !/^[A-Za-z0-9._/@+-]+$/.test(relative) ||
      relative.split("/").some((p) => !p || p === "." || p === "..") ||
      !Number.isSafeInteger(maximum) ||
      maximum < 0 ||
      maximum > FILE_BYTES
    )
      throw invalid();
    if (this.#dependencyMetadata.has(relative)) return Math.min(1024 * 1024, maximum);
    if (relative.split("/").includes("node_modules")) throw invalid();
    const control = controls.get(relative);
    if (control !== undefined) return Math.min(control, maximum);
    if (!metadata.includes(relative) && !roots.some((root) => relative.startsWith(root)))
      throw invalid();
    return maximum;
  }
  #remember(path: string, stat: BigIntStats): void {
    const prior = this.#topology.get(path);
    if (prior && !same(prior, stat)) throw invalid();
    if (!prior && this.#topology.size >= MAX_FILES) throw invalid();
    this.#topology.set(path, stat);
  }
  async #canonical(path: string, observed: Map<string, BigIntStats>): Promise<string> {
    const seen = new Set<string>();
    let hops = 0;
    for (;;) {
      this.#live();
      if (!path.startsWith("/app/") || path.length > 4096) throw invalid();
      const parts = path.slice(1).split("/");
      let current = "";
      const rootStat = lstatSync("/", { bigint: true });
      this.#directory(rootStat);
      this.#remember("/", rootStat);
      observed.set("/", rootStat);
      let restart = false;
      for (let index = 0; index < parts.length; index++) {
        current += "/" + parts[index];
        const stat = lstatSync(current, { bigint: true });
        if (stat.isSymbolicLink()) {
          // Only fixed package lookup links may redirect into the installed package tree.
          if (
            stat.uid !== 0n ||
            current === "/app/node_modules/.pnpm" ||
            seen.has(current) ||
            ++hops > 32 ||
            !/^\/app\/(?:node_modules|(?:apps\/api|packages\/(?:db|domain|platform-contracts))\/node_modules|node_modules\/\.pnpm\/[^/]+\/node_modules)\/(?:@[^/]+\/)?[^/@]+$/.test(
              current,
            )
          )
            throw invalid();
          seen.add(current);
          const target = resolve(dirname(current), readlinkSync(current));
          if (
            !target.startsWith("/app/node_modules/.pnpm/") &&
            ![
              "/app/apps/api",
              "/app/packages/db",
              "/app/packages/domain",
              "/app/packages/platform-contracts",
            ].includes(target)
          )
            throw invalid();
          if (!same(stat, lstatSync(current, { bigint: true }))) throw invalid();
          this.#remember(current, stat);
          observed.set(current, stat);
          path = target + (index < parts.length - 1 ? "/" + parts.slice(index + 1).join("/") : "");
          restart = true;
          break;
        }
        if (index < parts.length - 1 || stat.isDirectory()) this.#directory(stat);
        else this.#file(stat, FILE_BYTES);
        this.#remember(current, stat);
        observed.set(current, stat);
      }
      if (!restart) return Promise.resolve(current);
    }
  }
  /** Capture real Node package resolution and protected owner metadata; no authority is issued. */
  async capturePackage(
    importer: string,
    name:
      | "fflate"
      | "write-excel-file"
      | "@react-pdf/renderer"
      | "@markiro/db"
      | "@markiro/domain"
      | "@markiro/platform-contracts",
  ): Promise<Readonly<{ owner: string; entry: string; metadata: Buffer }>> {
    try {
      this.#live();
      const observed = new Map<string, BigIntStats>();
      if (!/^(?:apps\/api|packages\/platform-contracts)\/dist\/[^\\:]+\.(?:js|cjs)$/.test(importer))
        throw invalid();
      await this.read(importer, FILE_BYTES);
      if (
        ![
          "fflate",
          "write-excel-file",
          "@react-pdf/renderer",
          "@markiro/db",
          "@markiro/domain",
          "@markiro/platform-contracts",
        ].includes(name)
      )
        throw invalid();
      const require = createRequire("/app/" + importer);
      let owner: string | undefined;
      for (const modules of require.resolve.paths(name) ?? []) {
        if (!modules.startsWith("/app/")) break;
        try {
          owner = await this.#canonical(modules + "/" + name, observed);
          break;
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
          throw error;
        }
      }
      if (!owner) throw invalid();
      const specifier = name === "write-excel-file" ? name + "/node" : name;
      const entry = await this.#canonical(require.resolve(specifier), observed);
      if (!entry.startsWith(owner + "/")) throw invalid();
      const manifest = await this.#canonical(owner + "/package.json", observed);
      const relative = manifest.slice("/app/".length);
      this.#dependencyMetadata.add(relative);
      const metadata = await this.read(relative, 1024 * 1024);
      if ((await this.#canonical(require.resolve(specifier), observed)) !== entry) throw invalid();
      await this.#assertCapture(observed, new Set([importer, relative]));
      return Object.freeze({ owner, entry, metadata });
    } catch {
      this.dispose();
      throw invalid();
    }
  }
  /** Capture-local freshness; complete cross-capture fences remain mandatory before B2 issuance. */
  async #assertCapture(
    observed: ReadonlyMap<string, BigIntStats>,
    records: ReadonlySet<string>,
  ): Promise<void> {
    this.#live();
    for (const [path, snapshot] of observed) {
      if (!same(snapshot, lstatSync(path, { bigint: true }))) throw invalid();
    }
    for (const relative of records) {
      const record = this.#records.get(relative);
      if (!record) throw invalid();
      if (!same(record.stat, lstatSync("/app/" + relative, { bigint: true }))) throw invalid();
      for (const [path, snapshot] of record.parents) {
        const current = lstatSync(path, { bigint: true });
        this.#directory(current);
        if (!same(snapshot, current)) throw invalid();
      }
    }
    this.#live();
    return Promise.resolve();
  }
  /** Complete B1 path inventory only; required artifacts and byte digests are checked by B2. */
  async inventory(): Promise<ReadonlyArray<string>> {
    const files: string[] = [];
    let entries = 0;
    const dependencies = new Set([
      "node_modules",
      "apps/api/node_modules",
      "packages/db/node_modules",
      "packages/domain/node_modules",
      "packages/platform-contracts/node_modules",
    ]);
    const fixed = [...metadata, ...controls.keys()];
    const walk = async (relative: string): Promise<void> => {
      this.#live();
      const path = relative ? "/app/" + relative : "/app";
      const before = lstatSync(path, { bigint: true });
      this.#directory(before);
      this.#remember(path, before);
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++entries > MAX_FILES) throw invalid();
        const candidate = relative ? relative + "/" + entry.name : entry.name;
        const stat = lstatSync("/app/" + candidate, { bigint: true });
        if (dependencies.has(candidate)) {
          // Dependency bytes are separately image-attested; resolution snapshots check used links.
          this.#directory(stat);
          this.#remember("/app/" + candidate, stat);
          continue;
        }
        if (stat.isDirectory()) {
          if (
            !roots.some((root) => root.startsWith(candidate + "/") || candidate.startsWith(root)) &&
            !fixed.some((file) => file.startsWith(candidate + "/"))
          )
            throw invalid();
          await walk(candidate);
          continue;
        }
        const limit = this.#path(candidate, FILE_BYTES);
        this.#file(stat, limit);
        this.#remember("/app/" + candidate, stat);
        if (!controls.has(candidate)) files.push(candidate);
      }
      if (!same(before, lstatSync(path, { bigint: true }))) throw invalid();
      this.#live();
    };
    try {
      this.#live();
      const root = lstatSync("/", { bigint: true });
      this.#directory(root);
      this.#remember("/", root);
      await walk("");
      await this.assertUnchanged();
      return Object.freeze(files.sort());
    } catch {
      this.dispose();
      throw invalid();
    }
  }
  async read(relative: string, maximum: number): Promise<Buffer> {
    let temporary: Buffer | undefined;
    let reserved = 0;
    let pending = false;
    try {
      this.#live();
      const limit = this.#path(relative, maximum);
      const prior = this.#records.get(relative);
      if (prior) {
        if (prior.bytes.length > limit) throw invalid();
        return prior.bytes;
      }
      if (this.#records.size + this.#pending.size >= MAX_FILES || this.#pending.has(relative))
        throw invalid();
      this.#pending.add(relative);
      pending = true;
      const parts = relative.split("/");
      const parents: Array<readonly [string, BigIntStats]> = [];
      const rootStat = lstatSync("/", { bigint: true });
      this.#directory(rootStat);
      parents.push(["/", rootStat]);
      let parent = "/app";
      for (let index = 0; index < parts.length; index++) {
        const stat = lstatSync(parent, { bigint: true });
        this.#directory(stat);
        parents.push([parent, stat]);
        if (index < parts.length - 1) parent += "/" + parts[index];
      }
      const path = "/app/" + relative;
      const before = lstatSync(path, { bigint: true });
      this.#file(before, limit);
      if (this.#total + this.#reserved + Number(before.size) > TOTAL_BYTES) throw invalid();
      reserved = Number(before.size);
      this.#reserved += reserved;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const opened = await handle.stat({ bigint: true });
        this.#file(opened, limit);
        if (!same(before, opened)) throw invalid();
        temporary = Buffer.alloc(Number(opened.size) + 1);
        let length = 0;
        while (length < temporary.length) {
          const read = await handle.read(temporary, length, temporary.length - length, length);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (
          length !== Number(opened.size) ||
          !same(opened, await handle.stat({ bigint: true })) ||
          !same(opened, lstatSync(path, { bigint: true }))
        )
          throw invalid();
        for (const [directory, snapshot] of parents) {
          const current = lstatSync(directory, { bigint: true });
          this.#directory(current);
          if (!same(snapshot, current)) throw invalid();
        }
        this.#live();
        const bytes = Buffer.from(temporary.subarray(0, length));
        temporary.fill(0);
        temporary = undefined;
        this.#records.set(relative, { bytes, stat: opened, parents });
        this.#total += length;
        return bytes;
      } finally {
        await handle.close();
      }
    } catch {
      this.dispose();
      throw invalid();
    } finally {
      temporary?.fill(0);
      this.#reserved -= reserved;
      if (pending) this.#pending.delete(relative);
    }
  }
  async assertUnchanged(): Promise<void> {
    try {
      this.#live();
      for (const [path, snapshot] of this.#topology) {
        if (!same(snapshot, lstatSync(path, { bigint: true }))) throw invalid();
      }
      for (const [relative, record] of this.#records) {
        if (!same(record.stat, lstatSync("/app/" + relative, { bigint: true }))) throw invalid();
        for (const [path, snapshot] of record.parents) {
          const current = lstatSync(path, { bigint: true });
          this.#directory(current);
          if (!same(snapshot, current)) throw invalid();
        }
      }
      this.#live();
      return Promise.resolve();
    } catch {
      throw invalid();
    }
  }
  dispose(): void {
    this.#disposed = true;
    for (const record of this.#records.values()) record.bytes.fill(0);
    this.#records.clear();
    this.#topology.clear();
    this.#dependencyMetadata.clear();
    this.#total = 0;
  }
}
