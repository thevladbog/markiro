import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { STATION_PREFLIGHTS, verifyStationCors } from "../verify-api-cors.mjs";

const FAILURE = "Station CORS verification failed";
const STATION_ORIGIN = "http://tauri.localhost";
const expected = [
  ["/station/pair", "POST", "content-type,x-station-capabilities"],
  ["/station/identity", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/station/operators", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/station/scans", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/open", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products/gtin-check", "POST", "content-type,x-api-key,x-station-capabilities"],
];

test("matches the authoritative API Station CORS surface", async () => {
  const source = await readFile(
    new URL("../../../apps/api/test/cors-station-surface.test.ts", import.meta.url),
    "utf8",
  );
  const block = source.match(/const documentedStationSurface = \[([\s\S]*?)\] as const;/)?.[1];
  assert.ok(block, "API Station CORS surface must remain declarative");
  const apiSurface = [...block.matchAll(/\["(GET|POST)", "([^"]+)"\]/g)].map(([, method, path]) => [
    path.replace("/shift-1/", "/cors-probe/"),
    method,
  ]);

  assert.deepEqual(
    STATION_PREFLIGHTS.map(({ path, method }) => [path, method]).toSorted(),
    apiSurface.toSorted(),
  );
});

function response(status, acao, body = "", { allowHeaders, allowMethods } = {}) {
  const headers = acao === undefined ? {} : { "Access-Control-Allow-Origin": acao };
  if (allowMethods !== undefined) headers["Access-Control-Allow-Methods"] = allowMethods;
  if (allowHeaders !== undefined) headers["Access-Control-Allow-Headers"] = allowHeaders;
  return new Response(status === 204 && body === "" ? undefined : body, { status, headers });
}

function approvedPreflightHeaders(index) {
  const [, method, headers] = expected[index];
  return { allowMethods: method.toLowerCase(), allowHeaders: headers.toUpperCase() };
}

function approvedResponse(index) {
  return response(204, STATION_ORIGIN, "", approvedPreflightHeaders(index));
}

test("sends the exact ordered Windows station API preflight inventory", async () => {
  const calls = [];
  await verifyStationCors({
    apiUrl: "https://admin.markiro.app",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, "OPTIONS");
      assert.equal(init.headers.Origin, STATION_ORIGIN);
      return approvedResponse(calls.length - 1);
    },
  });
  assert.deepEqual(
    calls.map(({ url, init }) => [
      new URL(url).pathname,
      init.headers["Access-Control-Request-Method"],
      init.headers["Access-Control-Request-Headers"],
    ]),
    expected,
  );
});

test("fails closed for every invalid station API preflight without disclosing response bodies", async (t) => {
  for (const [failure, name] of [
    ["wrong-origin", "wrong ACAO"],
    ["wrong-status", "non-204 status"],
  ]) {
    for (const [index, [path]] of expected.entries()) {
      await t.test(`${name}: ${path}`, async () => {
        const fakeSecret = `fake-secret-${failure}-${index}`;
        let call = 0;
        await assert.rejects(
          verifyStationCors({
            apiUrl: "https://admin.markiro.app",
            fetchImpl: async () => {
              const current = call++;
              if (current !== index) return approvedResponse(current);
              return failure === "wrong-origin"
                ? response(204, "https://station.example.ru", "", approvedPreflightHeaders(index))
                : response(403, STATION_ORIGIN, fakeSecret, approvedPreflightHeaders(index));
            },
          }),
          (error) => {
            assert.equal(error.message, FAILURE);
            assert.doesNotMatch(error.message, new RegExp(fakeSecret));
            return true;
          },
        );
      });
    }
  }
});

test("fails closed when any Station preflight omits or mismatches allowed methods or headers", async (t) => {
  for (const [name, invalidHeaders] of [
    ["missing allow-methods", (method, headers) => ({ allowHeaders: headers })],
    [
      "wrong allow-methods",
      (method, headers) => ({
        allowMethods: method === "GET" ? "POST" : "GET",
        allowHeaders: headers,
      }),
    ],
    ["missing allow-headers", (method) => ({ allowMethods: method })],
    ["wrong allow-headers", (method) => ({ allowMethods: method, allowHeaders: "content-type" })],
  ]) {
    for (const [index, [path, method, headers]] of expected.entries()) {
      await t.test(`${name}: ${path}`, async () => {
        let call = 0;
        await assert.rejects(
          verifyStationCors({
            apiUrl: "https://admin.markiro.app",
            fetchImpl: async () => {
              const current = call++;
              if (current !== index) return approvedResponse(current);
              return response(204, STATION_ORIGIN, "", invalidHeaders(method, headers));
            },
          }),
          { message: FAILURE },
        );
      });
    }
  }
});

test("fails closed on a non-204 response without exposing its body", async () => {
  const fakeSecret = "fake-secret-body-value";
  await assert.rejects(
    verifyStationCors({
      apiUrl: "https://admin.markiro.app",
      fetchImpl: async () => response(403, STATION_ORIGIN, fakeSecret, approvedPreflightHeaders(0)),
    }),
    (error) => {
      assert.equal(error.message, FAILURE);
      assert.doesNotMatch(error.message, new RegExp(fakeSecret));
      return true;
    },
  );
});

test("rejects unsafe and non-canonical API URLs before fetching", async (t) => {
  for (const apiUrl of [
    "http://admin.markiro.app",
    "https://admin.markiro.app/",
    "https://ADMIN.markiro.app",
    "https://admin.markiro.app/station",
    "https://admin.markiro.app?source=station",
    "https://admin.markiro.app#station",
    "https://user:password@admin.markiro.app",
  ]) {
    await t.test(apiUrl, async () => {
      let called = false;
      await assert.rejects(
        verifyStationCors({
          apiUrl,
          fetchImpl: async () => {
            called = true;
            return response(204, STATION_ORIGIN);
          },
        }),
        { message: FAILURE },
      );
      assert.equal(called, false);
    });
  }
});

test("normalizes fetch failures to the secret-free verifier error", async () => {
  const fakeSecret = "fake-network-secret";
  await assert.rejects(
    verifyStationCors({
      apiUrl: "https://admin.markiro.app",
      fetchImpl: async () => {
        throw new Error(fakeSecret);
      },
    }),
    (error) => {
      assert.equal(error.message, FAILURE);
      assert.doesNotMatch(error.message, new RegExp(fakeSecret));
      return true;
    },
  );
});
