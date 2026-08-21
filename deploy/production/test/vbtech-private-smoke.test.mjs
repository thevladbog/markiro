import assert from "node:assert/strict";
import test from "node:test";

import { privateVbtechRequestClient, runPrivateVbtechSmoke } from "../vbtech-private-smoke.mjs";
import { VBTECH_ROUTE_CHECKS } from "../smoke.mjs";

const transportOrigin = "https://app.markiro.example";
const releaseSha = "c".repeat(40);
const vbtechCsp =
  "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; frame-src https://smartcaptcha.cloud.yandex.ru; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline' https://smartcaptcha.cloud.yandex.ru; style-src 'self' 'unsafe-inline'; upgrade-insecure-requests";

function vbtechResponse({ status = 200, body = "not found", headers = {}, bodyReads } = {}) {
  return {
    status,
    headers: new Headers({
      "content-security-policy": vbtechCsp,
      "strict-transport-security": "max-age=63072000; includeSubDomains",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "strict-origin-when-cross-origin",
      "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
      "x-vbtech-release-sha": releaseSha,
      ...headers,
    }),
    text: async () => {
      bodyReads?.push(body);
      return body;
    },
  };
}

test("private v-b request client preserves a logical apex path and query on the Markiro TLS authority", async () => {
  const calls = [];
  const client = privateVbtechRequestClient({
    transportOrigin,
    apexAuthority: "v-b.tech",
    wwwAuthority: "www.v-b.tech",
    request: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return vbtechResponse();
    },
  });

  await client.request("https://v-b.tech/legal/?from=private", {
    method: "GET",
    headers: { accept: "text/html" },
    redirect: "manual",
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.href, "https://app.markiro.example/legal/?from=private");
  assert.equal(calls[0].url.hostname, "app.markiro.example");
  assert.equal(calls[0].url.username, "");
  assert.equal(calls[0].url.password, "");
  assert.equal(new Headers(calls[0].init.headers).get("host"), "v-b.tech");
  assert.equal(new Headers(calls[0].init.headers).get("accept"), "text/html");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(Object.hasOwn(calls[0].init, "rejectUnauthorized"), false);
});

test("private v-b request client maps the www authority and rejects untrusted routing before network activity", async (t) => {
  const calls = [];
  const client = privateVbtechRequestClient({
    transportOrigin,
    apexAuthority: "https://v-b.tech",
    wwwAuthority: "https://www.v-b.tech",
    request: async (url, init) => {
      calls.push({ url: new URL(url), init });
      return vbtechResponse();
    },
  });

  await client.request("https://www.v-b.tech/canonical-check", {
    method: "GET",
    redirect: "manual",
  });
  assert.equal(calls[0].url.href, "https://app.markiro.example/canonical-check");
  assert.equal(new Headers(calls[0].init.headers).get("host"), "www.v-b.tech");
  assert.equal(calls[0].init.redirect, "manual");

  for (const [name, invoke] of [
    [
      "unexpected logical origin",
      () => client.request("https://other.example/legal/", { method: "GET" }),
    ],
    [
      "conflicting Host header",
      () =>
        client.request("https://v-b.tech/legal/", {
          method: "GET",
          headers: { Host: "evil.example" },
        }),
    ],
  ]) {
    await t.test(name, async () => {
      const before = calls.length;
      await assert.rejects(invoke, /private v-b request is invalid/);
      assert.equal(calls.length, before);
    });
  }
});

test("private v-b request client rejects unsafe transport and logical authorities before network activity", async (t) => {
  const base = {
    apexAuthority: "v-b.tech",
    wwwAuthority: "www.v-b.tech",
  };
  const unsafeTransports = [
    "http://app.markiro.example",
    "https://127.0.0.1",
    "https://[::1]",
    "https://app.markiro.example:8443",
    "https://user:pass@app.markiro.example",
    "https://app.markiro.example/private",
    "https://app.markiro.example?private=value",
    "https://app.markiro.example#private",
    "https://v-b.tech",
  ];

  for (const transportOrigin of unsafeTransports) {
    await t.test(`transport ${transportOrigin}`, () => {
      let calls = 0;
      assert.throws(
        () =>
          privateVbtechRequestClient({
            ...base,
            transportOrigin,
            request: async () => {
              calls += 1;
              return vbtechResponse();
            },
          }),
        /private v-b transport origin is invalid/,
      );
      assert.equal(calls, 0);
    });
  }

  for (const [name, overrides] of [
    ["an unexpected apex authority", { apexAuthority: "other.example" }],
    ["an unexpected www authority", { wwwAuthority: "www.other.example" }],
    ["a logical authority port", { apexAuthority: "v-b.tech:443" }],
  ]) {
    await t.test(name, () => {
      let calls = 0;
      assert.throws(
        () =>
          privateVbtechRequestClient({
            ...base,
            ...overrides,
            transportOrigin,
            request: async () => {
              calls += 1;
              return vbtechResponse();
            },
          }),
        /private v-b logical authority is invalid/,
      );
      assert.equal(calls, 0);
    });
  }
});

test("private v-b smoke reuses every public assertion through private routing evidence only", async () => {
  const requests = [];
  const bodyReads = [];
  const page = `<!doctype html><html data-theme="light"><head><meta name="vbtech-release-sha" content="${releaseSha}"></head><body>private content</body></html>`;
  const transportClient = {
    async request(url, init) {
      const target = new URL(url);
      const host = new Headers(init.headers).get("host");
      requests.push({
        method: init.method,
        host,
        path: target.pathname,
        search: target.search,
        redirect: init.redirect,
        transportOrigin: target.origin,
      });
      if (host === "www.v-b.tech")
        return vbtechResponse({
          status: 308,
          body: "private redirect body",
          bodyReads,
          headers: { location: "https://v-b.tech/canonical-check" },
        });
      if (target.pathname === "/api/contact" && init.method === "POST")
        return vbtechResponse({
          status: 404,
          body: '{"code":"submission_disabled"}',
          bodyReads,
          headers: { "content-type": "application/json" },
        });
      if (target.pathname.startsWith("/api/"))
        return vbtechResponse({
          status: 404,
          body: "private not found",
          bodyReads,
          headers: { "content-type": "text/plain" },
        });
      if (target.pathname === "/station/bootstrap" || target.pathname === "/kiosk/bootstrap")
        return vbtechResponse({
          status: 404,
          body: page,
          bodyReads,
          headers: { "content-type": "text/html" },
        });
      return vbtechResponse({ body: page, bodyReads, headers: { "content-type": "text/html" } });
    },
  };

  const evidence = await runPrivateVbtechSmoke(
    { transportOrigin, expectedVbtechReleaseSha: releaseSha },
    transportClient,
  );

  assert.deepEqual(
    requests.slice(0, -1).map(({ method, host, path }) => [method, host, path]),
    VBTECH_ROUTE_CHECKS.map(([method, path]) => [method, "v-b.tech", path]),
  );
  assert.deepEqual(requests.at(-1), {
    method: "GET",
    host: "www.v-b.tech",
    path: "/canonical-check",
    search: "",
    redirect: "manual",
    transportOrigin,
  });
  assert.equal(bodyReads.length, VBTECH_ROUTE_CHECKS.length);
  assert.deepEqual(evidence, {
    scope: "private-routing-content-only",
    publicDns: "not-verified",
    vbtechTls: "not-verified",
  });
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /private content|public DNS accepted|v-b TLS accepted/,
  );
});
