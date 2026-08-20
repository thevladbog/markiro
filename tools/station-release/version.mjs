import { execFile as execFileCallback } from "node:child_process";
import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const STATION_TAG_PREFIX = "station-v";
const STATION_BETA_TAG = /^station-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
const STATION_BETA_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.([1-9]\d*)$/;
const BUMPS = new Set(["next-beta", "next-patch-beta", "next-minor-beta", "next-major-beta"]);

function invalid(message = "invalid station beta version") {
  throw new Error(message);
}

function parseVersion(match, text) {
  const [major, minor, patch, beta] = match.slice(1).map(Number);
  if (![major, minor, patch, beta].every(Number.isSafeInteger)) return null;
  return { major, minor, patch, beta, text };
}

export function parseStationBetaTag(tag) {
  if (typeof tag !== "string") return null;
  const match = STATION_BETA_TAG.exec(tag);
  return match ? parseVersion(match, `${match[1]}.${match[2]}.${match[3]}-beta.${match[4]}`) : null;
}

function parseStationBetaVersion(version) {
  if (typeof version !== "string") return null;
  const match = STATION_BETA_VERSION.exec(version);
  return match ? parseVersion(match, version) : null;
}

function compareVersions(left, right) {
  for (const field of ["major", "minor", "patch", "beta"]) {
    if (left[field] !== right[field]) return left[field] - right[field];
  }
  return 0;
}

function ensureSafeIncrement(value) {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    invalid("invalid station beta version");
  }
  return value + 1;
}

export function nextStationBetaVersion(tags, bump) {
  if (!BUMPS.has(bump)) invalid("invalid station beta bump");
  if (!Array.isArray(tags)) invalid("invalid station beta tags");
  const versions = [...tags]
    .map(parseStationBetaTag)
    .filter((version) => version !== null)
    .sort(compareVersions);
  const highest = versions.at(-1) ?? { major: 0, minor: 1, patch: 0, beta: 0 };
  let major = highest.major;
  let minor = highest.minor;
  let patch = highest.patch;
  if (bump === "next-patch-beta") {
    patch = ensureSafeIncrement(patch);
  } else if (bump === "next-minor-beta") {
    minor = ensureSafeIncrement(minor);
    patch = 0;
  } else if (bump === "next-major-beta") {
    major = ensureSafeIncrement(major);
    minor = 0;
    patch = 0;
  }
  const beta = bump === "next-beta" ? ensureSafeIncrement(highest.beta) : 1;
  return `${major}.${minor}.${patch}-beta.${beta}`;
}

function sourcePaths(root) {
  return {
    config: fileURLToPath(new URL("apps/station/src-tauri/tauri.conf.json", root)),
    cargo: fileURLToPath(new URL("apps/station/src-tauri/Cargo.toml", root)),
  };
}

async function assertRegularFile(path) {
  const info = await lstat(path);
  if (!info.isFile()) invalid("invalid station beta source tree");
}

async function readSources(root) {
  const paths = sourcePaths(root);
  await Promise.all(Object.values(paths).map(assertRegularFile));
  let config;
  try {
    config = JSON.parse(await readFile(paths.config, "utf8"));
  } catch {
    invalid("invalid station beta source tree");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    invalid("invalid station beta source tree");
  }
  const cargo = await readFile(paths.cargo, "utf8");
  const cargoMatches = [...cargo.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)];
  if (cargoMatches.length !== 1 || typeof config.version !== "string") {
    invalid("invalid station beta source tree");
  }
  if (config.version !== cargoMatches[0][1]) invalid("invalid station beta source tree");
  return { paths, config, cargo, version: config.version };
}

export async function readStationSourceVersion(root) {
  const source = await readSources(root);
  if (!parseStationBetaVersion(source.version) && source.version !== "0.1.0") {
    invalid("invalid station beta source tree");
  }
  return source.version;
}

async function writeAtomic(path, content) {
  const temporary = `${path}.station-release-${process.pid}-${Date.now()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function writeStationSourceVersion(root, version) {
  if (!parseStationBetaVersion(version)) invalid("invalid station beta version");
  const source = await readSources(root);
  const config = `${JSON.stringify({ ...source.config, version }, null, 2)}\n`;
  const cargo = source.cargo.replace(/^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`);
  if (cargo === source.cargo) invalid("invalid station beta source tree");

  const backups = [];
  try {
    for (const path of Object.values(source.paths)) {
      const backup = `${path}.station-release-${process.pid}-${Date.now()}.bak`;
      await rename(path, backup);
      backups.push({ path, backup });
    }
    await writeAtomic(source.paths.config, config);
    await writeAtomic(source.paths.cargo, cargo);
    await Promise.all(backups.map(({ backup }) => rm(backup, { force: true })));
  } catch (error) {
    await Promise.all(
      backups.map(async ({ path, backup }) => {
        await rm(path, { force: true });
        await rename(backup, path).catch(() => undefined);
      }),
    );
    throw error;
  }
}

async function readTags() {
  const { stdout } = await execFile("git", ["tag", "--list", `${STATION_TAG_PREFIX}*`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter(Boolean);
}

async function writeOutput(path, version) {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`version=${version}\ntag=${STATION_TAG_PREFIX}${version}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function prepare(bump, outputPath) {
  if (!BUMPS.has(bump) || typeof outputPath !== "string" || outputPath.length === 0) {
    invalid("invalid station beta release arguments");
  }
  const root = pathToFileURL(`${dirname(fileURLToPath(import.meta.url))}/../../`);
  const current = await readStationSourceVersion(root);
  const version = nextStationBetaVersion(await readTags(), bump);
  if (current === version) invalid("invalid station beta release state");
  const reservation = await open(outputPath, "wx", 0o600);
  await reservation.close();
  try {
    await writeStationSourceVersion(root, version);
    await rm(outputPath, { force: true });
    await writeOutput(outputPath, version);
  } catch (error) {
    await rm(outputPath, { force: true });
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [, , command, bump, outputPath] = process.argv;
  if (command !== "prepare") invalid("invalid station beta release command");
  await prepare(bump, outputPath);
}
