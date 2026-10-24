import type { ChannelSnapshot } from "@markiro/platform-contracts";
import type { PinnedObject } from "./catalog-types";
export type CatalogReadSnapshot =
  | { kind: "object"; object: PinnedObject; mutable: boolean }
  | { kind: "pointer"; bytes: Buffer; sha256: string };
export interface CatalogReadSource {
  readSnapshot(path: string): Promise<CatalogReadSnapshot | null>;
}
export type CatalogPublicRoute =
  { kind: "immutable" } | { kind: "pointer" | "download"; identity: ChannelSnapshot["identity"] };
/** No decoding, queries, storage keys or arbitrary file selection at this boundary. */
export function publicCatalogRoute(path: string): CatalogPublicRoute | null {
  if (path.length > 512 || !/^\/[A-Za-z0-9/._+-]+$/.test(path)) return null;
  if (
    /^\/(?:(?:station|handheld)\/(?:beta|stable)\/releases|signer\/stable\/releases|standalone\/(?:beta|stable))\/[0-9]+\.[0-9]+\.[0-9]+(?:-beta\.[0-9]+)?\/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(
      path,
    )
  )
    return { kind: "immutable" };
  const parts = path.slice(1).split("/"),
    product = parts[0];
  if (
    product !== "station" &&
    product !== "handheld" &&
    product !== "standalone" &&
    product !== "signer"
  )
    return null;
  if (
    parts.length === 3 &&
    (parts[1] === "beta" || parts[1] === "stable") &&
    parts[2] === "latest.json" &&
    (product !== "signer" || parts[1] === "stable")
  )
    return { kind: "pointer", identity: { product, channel: parts[1] } };
  if (product !== "standalone") {
    if (parts.length === 2 && parts[1] === "download")
      return { kind: "download", identity: { product, channel: "stable" } };
    if (
      product !== "signer" &&
      parts.length === 3 &&
      parts[1] === "beta" &&
      parts[2] === "download"
    )
      return { kind: "download", identity: { product, channel: "beta" } };
  }
  return null;
}
