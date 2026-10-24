import type { ReleaseFileSpec } from "@markiro/platform-contracts";

export interface VerifiedInputFile {
  spec: ReleaseFileSpec;
  sha256: string;
  sizeBytes: number;
  read(maxBytes: number): Promise<Uint8Array>;
}
export type VerifiedInputFiles = ReadonlyMap<string, VerifiedInputFile>;

/** Internal storage binding; never accepted from a publication request. */
export interface PinnedObject {
  publicPath: string;
  bucket: string;
  key: string;
  versionId: string;
  sha256: string;
  sizeBytes: number;
  contentType: ReleaseFileSpec["contentType"];
}

/** Produced by the durable ledger, not by the HTTP caller. */
export interface VerifiedReceipt {
  operationId: string;
  sha256: string;
  ledgerKey: string;
  ledgerVersionId: string;
}
