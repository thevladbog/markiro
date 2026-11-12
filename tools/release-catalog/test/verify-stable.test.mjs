import assert from "node:assert/strict";
import { test } from "node:test";
import { createCatalogClient } from "../client.mjs";
import { verifyStablePublisher } from "../verify-stable.mjs";

const tokenUrl = "https://runner.actions.githubusercontent.com/oidc";
const catalogUrl = "https://saas-admin.markiro.app/api/release-publisher";
const publicationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const token = "safe.fixture.token";
const env = {
  ACTIONS_ID_TOKEN_REQUEST_URL: tokenUrl,
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-request-token",
};

function fixture(response) {
  const requests = [];
  const client = createCatalogClient({
    env,
    async fetchImpl(url, options) {
      requests.push([String(url), options]);
      if (new URL(url).origin === new URL(tokenUrl).origin) return Response.json({ value: token });
      return Response.json(response);
    },
  });
  return { client, requests };
}

test("verify only reads the exact stable channel via OIDC and returns no internal identifiers", async () => {
  for (const product of ["handheld", "standalone"]) {
    const snapshot = {
      identity: { product, channel: "stable" },
      revision: "17",
      publicationId,
      readable: true,
    };
    const { client, requests } = fixture(snapshot);
    assert.deepEqual(await verifyStablePublisher(product, client), {
      scope: snapshot.identity,
      revision: "17",
    });
    assert.equal(requests.length, 2);
    assert.equal(new URL(requests[0][0]).searchParams.get("audience"), "markiro-release-catalog");
    assert.equal(requests[1][0], `${catalogUrl}/channels/${product}/stable`);
    assert.equal(requests[1][1].method, "GET");
    assert.equal(requests[1][1].headers.Authorization, `Bearer ${token}`);
    assert.equal(requests[1][1].body, undefined);
  }
});

test("verify reports an empty stable channel after successful OIDC admission", async () => {
  for (const product of ["handheld", "standalone"]) {
    const identity = { product, channel: "stable" };
    const { client, requests } = fixture({
      identity,
      revision: "0",
      publicationId: null,
      readable: false,
    });
    assert.deepEqual(await verifyStablePublisher(product, client), {
      scope: identity,
      revision: "0",
      status: "empty",
    });
    assert.equal(requests.length, 2);
    assert.equal(requests[1][1].method, "GET");
  }
});

test("verify refuses unreadable, inconsistent and wrong channels", async () => {
  const snapshot = {
    identity: { product: "handheld", channel: "stable" },
    revision: "1",
    publicationId,
    readable: true,
  };
  for (const patch of [
    { revision: "0" },
    { publicationId: null },
    { readable: false },
    { identity: { product: "handheld", channel: "beta" } },
  ]) {
    const { client } = fixture({ ...snapshot, ...patch });
    await assert.rejects(verifyStablePublisher("handheld", client));
  }
  const { client, requests } = fixture(snapshot);
  await assert.rejects(verifyStablePublisher("station", client));
  assert.equal(requests.length, 0);
});
