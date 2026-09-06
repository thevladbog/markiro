import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_ENDPOINT,
  DEFAULT_WINDOW_DAYS,
  runIndexNow,
  selectChangedUrls,
  submitIndexNow,
  verifyKeyFile,
} from "../submit.mjs";

const KEY = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://markiro.app/</loc><lastmod>2026-09-06</lastmod></url>
  <url><loc>https://markiro.app/faq/</loc><lastmod>2026-08-14</lastmod></url>
  <url><loc>https://markiro.app/stati/</loc><lastmod>2026-09-01</lastmod></url>
  <url><loc>https://markiro.app/legal/</loc><lastmod>not-a-date</lastmod></url>
  <url><loc>https://markiro.app/privacy/</loc></url>
</urlset>`;

function jsonResponse(status, body = "") {
  return { status, ok: status >= 200 && status < 300, text: async () => body };
}

function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const handler = routes[String(url)];
    if (handler === undefined) return jsonResponse(404, "missing");
    return typeof handler === "function" ? handler(init) : handler;
  };
  return { calls, fetchImpl };
}

test("selects only URLs whose lastmod falls inside the window", () => {
  const now = new Date("2026-09-06T12:00:00Z");
  assert.deepEqual(selectChangedUrls(sitemap, { now, windowDays: 30 }), [
    "https://markiro.app/",
    "https://markiro.app/faq/",
    "https://markiro.app/stati/",
  ]);
  assert.deepEqual(selectChangedUrls(sitemap, { now, windowDays: 7 }), [
    "https://markiro.app/",
    "https://markiro.app/stati/",
  ]);
  assert.deepEqual(selectChangedUrls(sitemap, { now, windowDays: 1 }), ["https://markiro.app/"]);
  assert.deepEqual(selectChangedUrls("<urlset></urlset>", { now, windowDays: 30 }), []);
  assert.equal(DEFAULT_WINDOW_DAYS, 30);
  assert.equal(DEFAULT_ENDPOINT, "https://api.indexnow.org/indexnow");
});

test("refuses to submit when the key file is not published on the host", async () => {
  const { fetchImpl } = fakeFetch({ [`https://markiro.app/${KEY}.txt`]: jsonResponse(404) });
  await assert.rejects(
    verifyKeyFile(fetchImpl, "markiro.app", KEY),
    /IndexNow key file is not published/,
  );
  const mismatch = fakeFetch({ [`https://markiro.app/${KEY}.txt`]: jsonResponse(200, "other") });
  await assert.rejects(
    verifyKeyFile(mismatch.fetchImpl, "markiro.app", KEY),
    /IndexNow key file does not match/,
  );
  const ok = fakeFetch({ [`https://markiro.app/${KEY}.txt`]: jsonResponse(200, `${KEY}\n`) });
  await assert.doesNotReject(verifyKeyFile(ok.fetchImpl, "markiro.app", KEY));
});

test("posts one IndexNow request with the host, key location and URL list", async () => {
  const { calls, fetchImpl } = fakeFetch({ [DEFAULT_ENDPOINT]: jsonResponse(202) });
  await submitIndexNow(fetchImpl, {
    host: "markiro.app",
    key: KEY,
    urls: ["https://markiro.app/", "https://markiro.app/stati/"],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json; charset=utf-8");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    host: "markiro.app",
    key: KEY,
    keyLocation: `https://markiro.app/${KEY}.txt`,
    urlList: ["https://markiro.app/", "https://markiro.app/stati/"],
  });
});

test("fails closed on a rejected submission without echoing the key", async () => {
  const { fetchImpl } = fakeFetch({ [DEFAULT_ENDPOINT]: jsonResponse(403, "forbidden") });
  await assert.rejects(
    submitIndexNow(fetchImpl, { host: "markiro.app", key: KEY, urls: ["https://markiro.app/"] }),
    (error) => {
      assert.match(error.message, /IndexNow rejected the submission \(403\)/);
      assert.doesNotMatch(error.message, new RegExp(KEY));
      return true;
    },
  );
});

test("runs end to end from the live sitemap and logs counts only", async () => {
  const { calls, fetchImpl } = fakeFetch({
    "https://markiro.app/sitemap.xml": jsonResponse(200, sitemap),
    [`https://markiro.app/${KEY}.txt`]: jsonResponse(200, KEY),
    [DEFAULT_ENDPOINT]: jsonResponse(200),
  });
  const lines = [];
  const result = await runIndexNow({
    env: { PUBLIC_INDEXNOW_KEY: KEY, MARKIRO_LANDING_DOMAIN: "markiro.app" },
    fetchImpl,
    now: new Date("2026-09-06T12:00:00Z"),
    log: (line) => lines.push(line),
  });
  assert.deepEqual(result, { submitted: 3, considered: 5 });
  assert.equal(calls.filter((call) => call.url === DEFAULT_ENDPOINT).length, 1);
  assert.ok(lines.every((line) => !line.includes(KEY)));
  assert.match(lines.join("\n"), /3 of 5/);
});

test("skips quietly when no URL changed inside the window", async () => {
  const { calls, fetchImpl } = fakeFetch({
    "https://markiro.app/sitemap.xml": jsonResponse(200, sitemap),
    [`https://markiro.app/${KEY}.txt`]: jsonResponse(200, KEY),
  });
  const result = await runIndexNow({
    env: {
      PUBLIC_INDEXNOW_KEY: KEY,
      MARKIRO_LANDING_DOMAIN: "markiro.app",
      INDEXNOW_LASTMOD_WINDOW_DAYS: "0",
    },
    fetchImpl,
    now: new Date("2026-12-01T00:00:00Z"),
    log: () => {},
  });
  assert.deepEqual(result, { submitted: 0, considered: 5 });
  assert.equal(
    calls.some((call) => call.url === DEFAULT_ENDPOINT),
    false,
  );
});

test("rejects a missing or malformed key and domain before touching the network", async () => {
  const { calls, fetchImpl } = fakeFetch({});
  for (const env of [
    { MARKIRO_LANDING_DOMAIN: "markiro.app" },
    { PUBLIC_INDEXNOW_KEY: "short", MARKIRO_LANDING_DOMAIN: "markiro.app" },
    { PUBLIC_INDEXNOW_KEY: KEY },
    { PUBLIC_INDEXNOW_KEY: KEY, MARKIRO_LANDING_DOMAIN: "https://markiro.app" },
  ]) {
    await assert.rejects(
      runIndexNow({ env, fetchImpl, now: new Date(), log: () => {} }),
      (error) => {
        assert.doesNotMatch(error.message, new RegExp(KEY));
        return true;
      },
    );
  }
  assert.equal(calls.length, 0);
});
