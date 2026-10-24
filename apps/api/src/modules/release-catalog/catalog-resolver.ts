import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { VerifiedCache } from "./catalog-cache";
import { publicCatalogRoute, type CatalogReadSource } from "./catalog-read";
import { CatalogFault } from "./catalog-types";
export class CatalogResolver {
  constructor(
    private readonly source: CatalogReadSource,
    private readonly cache: Pick<VerifiedCache, "acquire">,
  ) {}
  async resolve(path: string) {
    if (!publicCatalogRoute(path)) throw new CatalogFault("not_found");
    // This is deliberately before cache acquisition, including warm-cache requests.
    const snapshot = await this.source.readSnapshot(path);
    if (!snapshot) throw new CatalogFault("not_found");
    if (snapshot.kind === "pointer") {
      const bytes = snapshot.bytes;
      if (
        bytes.length > 65536 ||
        createHash("sha256").update(bytes).digest("hex") !== snapshot.sha256
      )
        throw new CatalogFault("unavailable");
      return {
        sha256: snapshot.sha256,
        sizeBytes: bytes.length,
        contentType: "application/json",
        mutable: true,
        name: "latest.json",
        stream: (start: number, end: number) => Readable.from([bytes.subarray(start, end + 1)]),
        close: async () => {},
      };
    }
    const object = snapshot.object,
      lease = await this.cache.acquire(object);
    return {
      sha256: object.sha256,
      sizeBytes: object.sizeBytes,
      contentType: object.contentType,
      mutable: snapshot.mutable,
      name: object.publicPath.split("/").at(-1) ?? "release",
      stream: (start: number, end: number) => lease.createReadStream(start, end),
      close: () => lease.close(),
    };
  }
}
