import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCatalogClient } from "../client.mjs";
const id = "11111111-1111-4111-8111-111111111111";
const pubId = "22222222-2222-4222-8222-222222222222";
const opId = "33333333-3333-4333-8333-333333333333";
const hash = (b) => createHash("sha256").update(b).digest("hex");
function fixture() {
  const bytes = Buffer.from("installer fixture");
  const spec = {
    name: "manifest.json",
    sha256: hash(bytes),
    sizeBytes: bytes.length,
    contentType: "application/json",
  };
  const identity = { product: "handheld", channel: "stable", version: "1.7.0" };
  const publication = {
    identity,
    sourceSha: "a".repeat(40),
    files: [spec],
    evidence: { kind: "handheld", manifestName: "manifest.json", versionCode: 16 },
  };
  const intent = {
    id,
    identity,
    state: "pending",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    files: [{ ...spec, key: `handheld/_uploads/${id}/manifest.json` }],
  };
  const result = {
    publicationId: pubId,
    identity,
    files: [
      {
        ...spec,
        publicPath: "/handheld/stable/releases/1.7.0/manifest.json",
        versionId: "version/original+1",
      },
    ],
  };
  const calls = [],
    puts = [],
    versions = new Map();
  let counter = 0,
    publicBytes = bytes,
    commitFailure = false;
  const env = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token?old=1",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-secret",
  };
  const fetchImpl = async (url, options = {}) => {
    url = String(url);
    calls.push({ url, options });
    if (url.startsWith(env.ACTIONS_ID_TOKEN_REQUEST_URL))
      return Response.json({ value: "fixture.oidc.token" });
    if (url.startsWith("https://releases.markiro.app/")) return new Response(publicBytes);
    if (url.endsWith("/commit")) {
      if (commitFailure) return Response.json({ secret: "do not log" }, { status: 409 });
      return Response.json(result);
    }
    if (url.endsWith("/channels/handheld/stable"))
      return Response.json({
        identity: { product: "handheld", channel: "stable" },
        revision: options.method === "PUT" ? "2" : "1",
        publicationId: pubId,
        readable: true,
      });
    return Response.json(intent);
  };
  const store = {
    async put({ key, body, contentType }) {
      puts.push({ key, body, contentType });
      const versionId = ++counter === 1 ? "version/original+1" : `version-${counter}`;
      versions.set(versionId, Buffer.from(body));
      return versionId;
    },
  };
  const client = createCatalogClient({ env, fetchImpl, store });
  return {
    client,
    bytes,
    spec,
    publication,
    intent,
    result,
    calls,
    puts,
    versions,
    badPublic() {
      publicBytes = Buffer.from("wrong");
    },
    conflict() {
      commitFailure = true;
    },
  };
}
test("uses fixed audience, staged key and opaque returned version; commits then full public readback before CAS", async () => {
  const f = fixture();
  const intent = await f.client.createIntent(id, f.publication);
  const file = await f.client.uploadFile(intent, "manifest.json", f.bytes);
  assert.deepEqual(file, { name: "manifest.json", versionId: "version/original+1" });
  const result = await f.client.commitIntent(intent, [file]);
  await f.client.changeChannel(
    { product: "handheld", channel: "stable" },
    {
      operationId: opId,
      expectedRevision: "1",
      targetPublicationId: result.publicationId,
      kind: "forward",
    },
  );
  assert.equal(f.puts[0].key, `handheld/_uploads/${id}/manifest.json`);
  const token = f.calls.find((c) => c.url.includes("actions.githubusercontent.com"));
  assert.equal(new URL(token.url).searchParams.get("audience"), "markiro-release-catalog");
  assert.equal(token.options.redirect, "error");
  const publicCall = f.calls.find((c) => c.url.includes("releases.markiro.app"));
  assert.equal(publicCall.options.headers?.Authorization, undefined);
  const commitIndex = f.calls.findIndex((c) => c.url.endsWith("/commit"));
  const readIndex = f.calls.findIndex((c) => c.url.includes("releases.markiro.app"));
  const moveIndex = f.calls.findIndex((c) => c.options.method === "PUT");
  assert.ok(commitIndex < readIndex && readIndex < moveIndex);
});
test("delayed same-key PUT cannot change accepted binding and changed bytes never enter an upload", async () => {
  const f = fixture(),
    intent = await f.client.createIntent(id, f.publication);
  const original = await f.client.uploadFile(intent, "manifest.json", f.bytes);
  await f.client.commitIntent(intent, [original]);
  await assert.rejects(
    f.client.uploadFile(intent, "manifest.json", Buffer.from("replacement")),
    /invalid/,
  );
  const delayed = await f.client.uploadFile(intent, "manifest.json", f.bytes);
  assert.notEqual(original.versionId, delayed.versionId);
  const retry = await f.client.commitIntent(intent, [delayed]);
  assert.equal(retry.files[0].versionId, original.versionId);
  assert.equal(f.versions.get(original.versionId).equals(f.bytes), true);
});
test("missing version, caller-injected staging key and changed descriptor fail closed", async () => {
  const f = fixture();
  const forged = structuredClone(f.intent);
  forged.files[0].key = "handheld/stable/latest.json";
  await assert.rejects(f.client.uploadFile(forged, "manifest.json", f.bytes), /invalid/);
  await assert.rejects(
    f.client.commitIntent(f.intent, [{ name: "manifest.json", versionId: "null" }]),
    /invalid/,
  );
  assert.equal(f.puts.length, 0);
});
test("failed commit or full readback cannot move pointer; errors never echo remote body or credentials", async () => {
  for (const mode of ["conflict", "badPublic"]) {
    const f = fixture();
    f[mode]();
    await assert.rejects(
      f.client.commitIntent(f.intent, [{ name: "manifest.json", versionId: "v1" }]),
      (e) => !String(e).includes("do not log") && !String(e).includes("secret"),
    );
    await assert.rejects(
      f.client.changeChannel(
        { product: "handheld", channel: "stable" },
        { operationId: opId, expectedRevision: "1", targetPublicationId: pubId, kind: "forward" },
      ),
      /verified/,
    );
    assert.equal(
      f.calls.some((c) => c.options.method === "PUT"),
      false,
    );
  }
});
test("ambiguous request retry preserves supplied operation ID and expected revision", async () => {
  const f = fixture();
  await f.client.commitIntent(f.intent, [{ name: "manifest.json", versionId: "v1" }]);
  const change = {
    operationId: opId,
    expectedRevision: "1",
    targetPublicationId: pubId,
    kind: "forward",
  };
  await f.client.changeChannel({ product: "handheld", channel: "stable" }, change);
  await f.client.changeChannel({ product: "handheld", channel: "stable" }, change);
  const bodies = f.calls
    .filter((c) => c.options.method === "PUT")
    .map((c) => JSON.parse(c.options.body));
  assert.deepEqual(bodies, [change, change]);
});
test("token endpoint cannot send workflow credential to another host", async () => {
  let calls = 0;
  const client = createCatalogClient({
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://evil.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
    },
    fetchImpl: async () => {
      calls++;
      throw Error("secret");
    },
    store: {},
  });
  await assert.rejects(client.getIntent(id));
  assert.equal(calls, 0);
});
test("a later run validates the full accepted publication before CAS without any staged PUT", async () => {
  const f = fixture();
  // Fixture returns the accepted binding only for this authenticated lookup.
  const fetchImpl = async (url) => {
    if (String(url).includes("actions.githubusercontent.com"))
      return Response.json({ value: "fixture.oidc.token" });
    if (String(url).includes("/publications/")) return Response.json(f.result);
    if (String(url).includes("https://releases.markiro.app/")) return new Response(f.bytes);
    return Response.json({
      identity: { product: "handheld", channel: "stable" },
      revision: "2",
      publicationId: pubId,
      readable: true,
    });
  };
  const client = createCatalogClient({
    env: {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://fixture.actions.githubusercontent.com/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "secret",
    },
    fetchImpl,
    store: {
      put() {
        throw Error("must not write");
      },
    },
  });
  const result = await client.getPublication(f.publication);
  assert.deepEqual(result, f.result);
  await client.changeChannel(
    { product: f.publication.identity.product, channel: f.publication.identity.channel },
    { operationId: opId, expectedRevision: "1", targetPublicationId: pubId, kind: "forward" },
  );
  await assert.rejects(
    client.getPublication({ ...f.publication, files: [{ ...f.spec, sha256: "0".repeat(64) }] }),
  );
});
