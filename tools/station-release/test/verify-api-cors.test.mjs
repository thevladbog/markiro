import assert from "node:assert/strict";
import test from "node:test";
import { verifyStationCors } from "../verify-api-cors.mjs";

const FAILURE = "Station pairing CORS verification failed";
const STATION_ORIGIN = "http://tauri.localhost";

function response(status, acao, body = "") {
  const headers = acao === undefined ? {} : { "Access-Control-Allow-Origin": acao };
  return new Response(status === 204 && body === "" ? undefined : body, { status, headers });
}

test("sends the exact Windows station pairing preflight", async () => {
  let calls = 0;
  await verifyStationCors({
    apiUrl: "https://admin.markiro.app",
    fetchImpl: async (url, init) => {
      calls += 1;
      assert.equal(url, "https://admin.markiro.app/station/pair");
      assert.equal(init.method, "OPTIONS");
      assert.equal(init.headers.Origin, STATION_ORIGIN);
      assert.equal(init.headers["Access-Control-Request-Method"], "POST");
      assert.equal(
        init.headers["Access-Control-Request-Headers"],
        "content-type,x-station-capabilities",
      );
      return response(204, STATION_ORIGIN);
    },
  });
  assert.equal(calls, 1);
});

test("fails closed when ACAO is wrong or missing", async (t) => {
  for (const [name, acao] of [
    ["wrong", "https://station.example.ru"],
    ["missing", undefined],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        verifyStationCors({
          apiUrl: "https://admin.markiro.app",
          fetchImpl: async () => response(204, acao),
        }),
        { message: FAILURE },
      );
    });
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
