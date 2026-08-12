import assert from "node:assert/strict";
import test from "node:test";
import { verifyStationCors } from "../verify-api-cors.mjs";

const FAILURE = "Station CORS verification failed";
const STATION_ORIGIN = "http://tauri.localhost";
const expected = [
  ["/station/pair", "POST", "content-type,x-station-capabilities"],
  ["/station/operators", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/open", "POST", "content-type,x-api-key,x-station-capabilities"],
  ["/shifts/cors-probe/bundle", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products", "GET", "content-type,x-api-key,x-station-capabilities"],
  ["/products/gtin-check", "POST", "content-type,x-api-key,x-station-capabilities"],
];

function response(status, acao, body = "") {
  const headers = acao === undefined ? {} : { "Access-Control-Allow-Origin": acao };
  return new Response(status === 204 && body === "" ? undefined : body, { status, headers });
}

test("sends the exact ordered Windows station API preflight inventory", async () => {
  const calls = [];
  await verifyStationCors({
    apiUrl: "https://admin.markiro.app",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.method, "OPTIONS");
      assert.equal(init.headers.Origin, STATION_ORIGIN);
      return response(204, STATION_ORIGIN);
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
              if (current !== index) return response(204, STATION_ORIGIN);
              return failure === "wrong-origin"
                ? response(204, "https://station.example.ru")
                : response(403, STATION_ORIGIN, fakeSecret);
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

test("fails closed on a non-204 response without exposing its body", async () => {
  const fakeSecret = "fake-secret-body-value";
  await assert.rejects(
    verifyStationCors({
      apiUrl: "https://admin.markiro.app",
      fetchImpl: async () => response(403, STATION_ORIGIN, fakeSecret),
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
