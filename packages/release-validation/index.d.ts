export interface StationFileReader {
  names: readonly string[];
  size(name: string): number;
  text(name: string, maximum: number): Promise<string>;
  digest(name: string): Promise<string>;
}
export function stationAssetNames(version: string): {
  installer: string;
  bundle: string;
  signature: string;
  manifest: string;
  checksums: string;
  notes: string;
  evidence: string;
};
export function validateStationReleaseFiles(
  reader: StationFileReader,
  expected: { channel: "beta" | "stable"; origin: "github" | "yandex"; version: string },
): Promise<{ manifest: unknown; evidence: unknown; assets: Record<string, string> }>;
export interface HandheldManifest {
  versionName: string;
  versionCode: number;
  sha256: string;
  bytes: number;
  url: string;
  notes: string;
  releasedAt: string;
  sourceSha: string;
}
export function parseHandheldManifest(
  text: string,
  options?: { channel: "beta" | "stable" },
): HandheldManifest;
export function assertSupersedes(
  text: string | null,
  next: HandheldManifest,
  options?: { channel: "beta" | "stable" },
): HandheldManifest;
export function handheldApkName(version: string): string;

export function signerArtifactNames(version: string): { installer: string; signature: string };
export function validateSignerReleaseFiles(
  reader: StationFileReader,
  expected: { version: string },
): Promise<{ manifest: unknown; evidence: unknown; hashes: Record<string, string> }>;
