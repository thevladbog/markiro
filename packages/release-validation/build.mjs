import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = new URL("../../", import.meta.url);
const output = new URL("./dist/", import.meta.url);
// Package the canonical validators verbatim; never maintain a second acceptance policy.
for (const path of [
  "station-release/artifacts.mjs",
  "station-release/origins.mjs",
  "station-release/version.mjs",
  "handheld-release/manifest.mjs",
]) {
  const target = new URL(path, output);
  await mkdir(fileURLToPath(new URL("./", target)), { recursive: true });
  await copyFile(new URL(`tools/${path}`, root), target);
}
await writeFile(
  new URL("index.mjs", output),
  'export { stationAssetNames, validateStationReleaseFiles } from "./station-release/artifacts.mjs";\nexport { parseHandheldManifest, assertSupersedes, handheldApkName } from "./handheld-release/manifest.mjs";\n',
);
