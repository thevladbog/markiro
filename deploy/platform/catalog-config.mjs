import { fileURLToPath } from "node:url";
import { lstatSync, realpathSync } from "node:fs";
export const CATALOG_ROOT = "/opt/markiro-platform/release-catalog";
export const CATALOG_RUNTIME_KEYS = [
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "CACHE_DIR",
  "JOURNAL_DIR",
  "CACHE_BYTES",
  "OBJECT_BYTES",
  "DISK_RESERVE_BYTES",
  "DOWNLOADS",
  "TIMEOUT_MS",
  "WRITERS_ENABLED",
  "PUBLISHERS_JSON",
].map((k) => `RELEASE_CATALOG_${k}`);
const fail = () => {
  throw new Error("Invalid release catalog configuration");
};
export function validateCatalogConfig(env) {
  if (CATALOG_RUNTIME_KEYS.every((k) => !env[k])) return false;
  for (const k of CATALOG_RUNTIME_KEYS.filter((k) => !k.endsWith("PUBLISHERS_JSON")))
    if (!env[k] || env[k] !== env[k].trim() || /[\p{Cc}]/u.test(env[k])) fail();
  if (
    env.RELEASE_CATALOG_S3_ENDPOINT !== "https://s3.twcstorage.ru" ||
    env.RELEASE_CATALOG_S3_REGION !== "ru-1" ||
    env.RELEASE_CATALOG_S3_BUCKET !== env.MARKIRO_RELEASES_BUCKET ||
    env.RELEASE_CATALOG_CACHE_DIR !== `${CATALOG_ROOT}/cache` ||
    env.RELEASE_CATALOG_JOURNAL_DIR !== `${CATALOG_ROOT}/journal`
  )
    fail();
  const number = (key) => {
    const v = env[`RELEASE_CATALOG_${key}`];
    if (!/^[1-9]\d*$/.test(v) || !Number.isSafeInteger(Number(v))) fail();
    return Number(v);
  };
  const object = number("OBJECT_BYTES");
  if (
    object > 536870912 ||
    number("CACHE_BYTES") < object ||
    number("DOWNLOADS") > 2 ||
    number("TIMEOUT_MS") > 3600000
  )
    fail();
  number("DISK_RESERVE_BYTES");
  if (!["false", "true"].includes(env.RELEASE_CATALOG_WRITERS_ENABLED)) fail();
  if (env.RELEASE_CATALOG_WRITERS_ENABLED === "true" && !env.RELEASE_CATALOG_PUBLISHERS_JSON)
    fail();
  if (env.RELEASE_CATALOG_PUBLISHERS_JSON) {
    try {
      if (Buffer.byteLength(env.RELEASE_CATALOG_PUBLISHERS_JSON) > 65536) fail();
      const p = JSON.parse(env.RELEASE_CATALOG_PUBLISHERS_JSON);
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(p.repository) ||
        !["repositoryId", "ownerId"].every((k) => /^[1-9][0-9]{0,19}$/.test(p[k])) ||
        !Array.isArray(p.workflows) ||
        p.workflows.length < 1 ||
        p.workflows.length > 16
      )
        fail();
      for (const w of p.workflows)
        if (
          !["station", "handheld"].includes(w.product) ||
          typeof w.environment !== "string" ||
          !w.environment ||
          typeof w.workflowRef !== "string" ||
          !w.workflowRef.startsWith(`${p.repository}/.github/workflows/`) ||
          !w.workflowRef.endsWith("@refs/heads/main") ||
          !/^[a-f0-9]{40}$/.test(w.workflowSha) ||
          typeof w.subject !== "string" ||
          !w.subject.endsWith(`:environment:${w.environment}`)
        )
          fail();
    } catch {
      fail();
    }
  }
  return true;
}
/** The API is node:1000. Host preparation is explicit; never chown/create as a side effect. */
export function assertCatalogMounts(env, fs = { lstatSync, realpathSync }) {
  if (!validateCatalogConfig(env)) return;
  for (const path of [env.RELEASE_CATALOG_CACHE_DIR, env.RELEASE_CATALOG_JOURNAL_DIR]) {
    try {
      const s = fs.lstatSync(path);
      if (
        s.isSymbolicLink() ||
        !s.isDirectory() ||
        s.uid !== 1000 ||
        s.gid !== 1000 ||
        (s.mode & 0o777) !== 0o700 ||
        fs.realpathSync(path) !== path
      )
        fail();
    } catch {
      fail();
    }
  }
}

export function catalogMountBindings(env, service) {
  if (service !== "api" || (!env.RELEASE_CATALOG_CACHE_DIR && !env.RELEASE_CATALOG_JOURNAL_DIR))
    return {};
  if (
    env.RELEASE_CATALOG_CACHE_DIR !== `${CATALOG_ROOT}/cache` ||
    env.RELEASE_CATALOG_JOURNAL_DIR !== `${CATALOG_ROOT}/journal`
  )
    fail();
  return Object.fromEntries(
    ["cache", "journal"].map((name) => [`${CATALOG_ROOT}/${name}`, `${CATALOG_ROOT}/${name}`]),
  );
}

export function assertExclusiveCatalogMounts(containers, apiId) {
  const overlap = (source) =>
    typeof source === "string" &&
    (source === "/" ||
      source === CATALOG_ROOT ||
      source.startsWith(`${CATALOG_ROOT}/`) ||
      CATALOG_ROOT.startsWith(`${source}/`));
  for (const c of containers)
    if (c.Id !== apiId && (c.Mounts ?? []).some((m) => overlap(m.Source))) fail();
}

/** Fixed installed composition, derived from the byte-bound runtime rather than caller flags. */
export function catalogComposeFiles(env) {
  const files = ["compose.yml", "compose.compact.yml"];
  if (validateCatalogConfig(env)) files.push("compose.catalog.yml");
  return files.map((path) => fileURLToPath(new URL(path, import.meta.url)));
}
