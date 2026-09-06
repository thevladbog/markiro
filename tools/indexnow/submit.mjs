import process from "node:process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Submits recently changed landing URLs to IndexNow after a production deploy.
 *
 * The key is public by protocol (it is served at `/{key}.txt` so the search
 * engines can verify ownership), but it is still never printed: logs carry
 * counts and hosts only. HTTP acceptance is not proof of indexing; the runbook
 * keeps webmaster panels as the source of truth.
 */
export const DEFAULT_ENDPOINT = "https://api.indexnow.org/indexnow";
export const DEFAULT_WINDOW_DAYS = 30;
const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;
const HOST_PATTERN = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

function readKey(env) {
  const key = env.PUBLIC_INDEXNOW_KEY?.trim() ?? "";
  if (!KEY_PATTERN.test(key))
    throw new Error("PUBLIC_INDEXNOW_KEY must be 8-128 characters of a-z, A-Z, 0-9 or -");
  return key;
}

function readHost(env) {
  const host = env.MARKIRO_LANDING_DOMAIN?.trim() ?? "";
  if (!HOST_PATTERN.test(host)) throw new Error("MARKIRO_LANDING_DOMAIN must be a bare host name");
  return host.toLowerCase();
}

function readWindowDays(env) {
  const raw = env.INDEXNOW_LASTMOD_WINDOW_DAYS?.trim();
  if (raw === undefined || raw.length === 0) return DEFAULT_WINDOW_DAYS;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0 || days > 3650)
    throw new Error("INDEXNOW_LASTMOD_WINDOW_DAYS must be an integer number of days");
  return days;
}

/**
 * Returns the `<loc>` values whose `<lastmod>` is within `windowDays` before `now`.
 * The window is measured in UTC calendar days: sitemap dates are date-only values
 * that parse to midnight UTC, so a page reviewed exactly `windowDays` days ago is
 * still included whatever the current time of day.
 */
export function selectChangedUrls(sitemapXml, { now, windowDays }) {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const threshold = startOfToday - windowDays * DAY_MS;
  const urls = [];
  for (const match of sitemapXml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const entry = match[1];
    const loc = entry.match(/<loc>\s*([^<\s]+)\s*<\/loc>/)?.[1];
    const lastmod = entry.match(/<lastmod>\s*([^<\s]+)\s*<\/lastmod>/)?.[1];
    if (loc === undefined || lastmod === undefined) continue;
    const modified = Date.parse(lastmod);
    if (Number.isNaN(modified)) continue;
    if (modified >= threshold) urls.push(loc);
  }
  return urls;
}

export async function verifyKeyFile(fetchImpl, host, key) {
  const response = await fetchImpl(`https://${host}/${key}.txt`, { method: "GET" });
  if (response.status !== 200) throw new Error("IndexNow key file is not published on the host");
  const body = (await response.text()).trim();
  if (body !== key) throw new Error("IndexNow key file does not match the configured key");
}

export async function submitIndexNow(fetchImpl, { host, key, urls, endpoint = DEFAULT_ENDPOINT }) {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host,
      key,
      keyLocation: `https://${host}/${key}.txt`,
      urlList: urls,
    }),
  });
  if (response.status !== 200 && response.status !== 202)
    throw new Error(`IndexNow rejected the submission (${response.status})`);
}

export async function runIndexNow({
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = new Date(),
  log = console.log,
} = {}) {
  const key = readKey(env);
  const host = readHost(env);
  const windowDays = readWindowDays(env);
  const endpoint = env.INDEXNOW_ENDPOINT?.trim() || DEFAULT_ENDPOINT;

  const sitemapResponse = await fetchImpl(`https://${host}/sitemap.xml`, { method: "GET" });
  if (sitemapResponse.status !== 200) throw new Error(`sitemap.xml is unavailable on ${host}`);
  const sitemap = await sitemapResponse.text();
  const considered = (sitemap.match(/<url>/g) ?? []).length;
  const urls = selectChangedUrls(sitemap, { now, windowDays });
  log(`IndexNow: ${urls.length} of ${considered} sitemap URLs changed within ${windowDays} days`);
  if (urls.length === 0) return { submitted: 0, considered };

  await verifyKeyFile(fetchImpl, host, key);
  await submitIndexNow(fetchImpl, { host, key, urls, endpoint });
  log(`IndexNow: submitted ${urls.length} URLs for ${host}`);
  return { submitted: urls.length, considered };
}

function isMainModule(moduleUrl, argv = process.argv) {
  const entry = argv[1];
  if (typeof entry !== "string" || entry.length === 0) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    await runIndexNow();
  } catch (error) {
    console.error(
      `IndexNow submission failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
