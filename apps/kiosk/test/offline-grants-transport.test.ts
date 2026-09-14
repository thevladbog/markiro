import { generateKeyPairSync, sign, webcrypto } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { writeConfig } from "../src/store/config.js";
import { readGrantState } from "../src/grants/store.js";
import {
  beginGrantRequest,
  installGrantConfiguration,
  installGrantKeyset,
  installGrantResponse,
} from "../src/grants/transport.js";
import { flushKioskGrantReadiness, prepareKioskGrantReadiness } from "../src/grants/readiness.js";
const origin = "https://fixture.invalid",
  deviceId = "00000000-0000-4000-8000-000000000001";
const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const keyset = {
  protocol: "offline-grants-v1",
  origin,
  revision: "opaque-z",
  keys: [{ kid: "test-only", jwk: pair.publicKey.export({ format: "jwk" }) }],
  retiredKids: [] as string[],
};
const config = {
  serverUrl: origin,
  kioskId: deviceId,
  token: "test-only",
  kioskName: "Fixture",
  place: null,
  nextDeviceSeq: 1,
};
beforeEach(async () => {
  vi.stubGlobal("crypto", webcrypto);
  await writeConfig(config);
});
function issued(tenantId = "tenant", epoch = 7) {
  const owner = { tenantId, deviceId, kind: "kiosk", credentialEpoch: epoch };
  const payload = {
    ...owner,
    version: 1,
    issuer: origin,
    grantId: "11111111-1111-4111-8111-111111111111",
    entitlementRevision: "e1",
    policyRevision: "p1",
    issuedAt: 1000,
    notBefore: 1000,
    kindOfGrant: "device",
    startNotAfter: 100000,
    capabilities: ["pickup.start.v1"],
  };
  const input = [{ typ: "markiro-offline-grant+jws", alg: "ES256", kid: "test-only" }, payload]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  const compact =
    input +
    "." +
    sign("sha256", Buffer.from(input), {
      key: pair.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  return {
    status: "issued",
    envelope: {
      protocol: "offline-grants-v1",
      serverTime: 1000,
      owner,
      mode: "strict",
      grants: [compact],
      taskSnapshots: [],
    },
  };
}
it("unwraps the real issued response, bootstraps tenant/epoch and conservatively ages a delayed reply", async () => {
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantKeyset(lease, keyset);
  expect(await installGrantResponse(lease, issued())).toBe(true);
  const saved = await readGrantState();
  expect(saved).toMatchObject({
    tenantId: "tenant",
    epoch: 7,
    mode: "observe",
    device: { grant: { kindOfGrant: "device" } },
  });
  expect(saved?.clock?.monotonicMs).toBe(lease.started.monotonicMs);
  expect(saved?.clock?.highWaterMs).toBeGreaterThanOrEqual(1000);
});
it("persists retirement even when productive issuance is denied and never revives the kid", async () => {
  const first = await beginGrantRequest();
  if (!first) throw Error("lease");
  await installGrantKeyset(first, { ...keyset, retiredKids: ["test-only"] });
  expect(await installGrantResponse(first, { status: "denied", reason: "not_entitled" })).toBe(
    false,
  );
  const second = await beginGrantRequest();
  if (!second) throw Error("lease");
  await installGrantKeyset(second, { ...keyset, revision: "opaque-a" });
  expect((await readGrantState())?.retiredKids).toEqual(["test-only"]);
  await expect(installGrantResponse(second, issued())).rejects.toThrow("retired");
});
it("rejects old requests after a newer request or unpair/re-pair", async () => {
  const old = await beginGrantRequest();
  if (!old) throw Error("lease");
  await beginGrantRequest();
  expect(await installGrantKeyset(old, keyset)).toBe(false);
  await writeConfig({ ...config, token: null });
  await writeConfig(config);
  expect(await installGrantKeyset(old, keyset)).toBe(false);
});
it("does not accept a keyset from a different origin or rebind a persisted tenant", async () => {
  const first = await beginGrantRequest();
  if (!first) throw Error("lease");
  await expect(
    installGrantKeyset(first, { ...keyset, origin: "https://other.invalid" }),
  ).rejects.toThrow("origin");
  await installGrantKeyset(first, keyset);
  await installGrantResponse(first, issued());
  const second = await beginGrantRequest();
  if (!second) throw Error("lease");
  await expect(installGrantResponse(second, issued("other-tenant"))).rejects.toThrow("owner");
  expect((await readGrantState())?.tenantId).toBe("tenant");
});
it("configuration recovers strict clock/key retirement independently and requires approved rollback policy", async () => {
  const { installGrantConfiguration } = await import("../src/grants/transport.js");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  const configuration = {
    protocol: "offline-grants-v1",
    owner: { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 },
    serverTime: 1000,
    mode: "strict",
    policyRevision: "approved-v1",
    keyset,
  };
  expect(await installGrantConfiguration(lease, configuration)).toBe(true);
  const next = await beginGrantRequest();
  if (!next) throw Error("lease");
  await installGrantConfiguration(next, {
    ...configuration,
    serverTime: 2000,
    mode: "observe",
    policyRevision: null,
    keyset: { ...keyset, retiredKids: ["test-only"] },
  });
  expect(await readGrantState()).toMatchObject({ mode: "strict", retiredKids: ["test-only"] });
  const last = await beginGrantRequest();
  if (!last) throw Error("lease");
  await installGrantConfiguration(last, {
    ...configuration,
    serverTime: 3000,
    mode: "observe",
    policyRevision: "approved-rollback",
  });
  expect((await readGrantState())?.mode).toBe("observe");
});
it("attaches a signed task only to a real saved reservation and independently matching queue/product facts", async () => {
  const { enqueueOrder } = await import("../src/store/queue.js");
  const { withStore, STORE_SNAPSHOT, STORE_GRANTS } = await import("../src/store/db.js");
  const { persistGrantReservation } = await import("../src/grants/reservations.js");
  const { canonical, sha256, orderContent } = await import("../src/grants/scope.js");
  const { validatePickupKm } = await import("@markiro/domain");
  const rawKm = "010460068200001321KYC9X7MQ\u001d93Abcd",
    taskId = "00000000-0000-4000-8000-000000000003";
  const body = { deviceSeq: 1, badgeDigest: "badge", reason: "buy" as const, items: [{ rawKm }] };
  const km = validatePickupKm(rawKm);
  if (km.status === "not_km" || km.status === "incomplete") throw Error("km");
  await enqueueOrder(body, "employee", "pending_attestation");
  await withStore(STORE_SNAPSHOT, "readwrite", (s) =>
    s.put(
      { bootstrap: { products: [{ id: "product", gtin14: km.km.gtin14 }] }, fetchedAt: "fixture" },
      "current",
    ),
  );
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantKeyset(lease, keyset);
  const scope = {
    version: 1,
    deviceSeq: 1,
    payloadDigest: await sha256(orderContent(body)),
    reason: "buy",
    writeoffReasonId: null,
    badgeIdentityDigest: await sha256(canonical({ badgeDigest: "badge", badgeCode: null })),
    items: [{ rawKm, kmKey: km.key, productId: "product" }],
    boxes: [],
    unitCount: 1,
    containerCount: 0,
  };
  const text = canonical({ taskKind: "pickup", taskId, scope }),
    digest = await sha256(text);
  await persistGrantReservation(lease, body, {
    status: "reserved",
    protocol: "offline-grants-v1",
    admission: { claimedAt: "2026-09-13T00:00:00Z", admissionProof: "opaque-proof" },
    task: { taskKind: "pickup", taskId, snapshotDigest: digest },
  });
  const owner = { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 };
  const payload = {
    ...owner,
    version: 1,
    issuer: origin,
    grantId: "task-grant",
    entitlementRevision: "e1",
    policyRevision: "p1",
    issuedAt: 1000,
    notBefore: 1000,
    kindOfGrant: "task",
    taskKind: "pickup",
    taskId,
    snapshotDigest: digest,
    completeNotAfter: 100000,
    eventTypes: ["pickup.complete.v1"],
    budget: [
      { id: "pickup.complete.v1:events", unit: "event", maximum: 1 },
      { id: "pickup.complete.v1:units", unit: "unit", maximum: 1 },
      { id: "pickup.complete.v1:containers", unit: "container", maximum: 0 },
    ],
  };
  const input = [{ typ: "markiro-offline-grant+jws", alg: "ES256", kid: "test-only" }, payload]
    .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
    .join(".");
  const compact =
    input +
    "." +
    sign("sha256", Buffer.from(input), {
      key: pair.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
  expect(
    await installGrantResponse(
      lease,
      {
        status: "issued",
        envelope: {
          protocol: "offline-grants-v1",
          serverTime: 1000,
          owner,
          mode: "observe",
          grants: [compact],
          taskSnapshots: [{ taskKind: "pickup", taskId, snapshotDigest: digest, canonical: text }],
        },
      },
      1,
    ),
  ).toBe(true);
  const evidence = await withStore<unknown[]>(STORE_GRANTS, "readonly", (s) => s.getAll());
  expect(evidence).toContainEqual(
    expect.objectContaining({ compact, canonical: text, purpose: "accepted_order_evidence" }),
  );
});
it("ages the full delayed request, distrusts reload/wall rollback, then recovers with an authenticated reanchor", async () => {
  const { clockSample, trustedNow } = await import("../src/grants/clock.js");
  const { installGrantConfiguration } = await import("../src/grants/transport.js");
  let monotonic = 100,
    wall = 10000;
  const monoSpy = vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  const wallSpy = vi.spyOn(Date, "now").mockImplementation(() => wall);
  try {
    const lease = await beginGrantRequest();
    if (!lease) throw Error("lease");
    await installGrantKeyset(lease, keyset);
    monotonic = 5100;
    await installGrantResponse(lease, issued());
    const first = await readGrantState();
    if (!first?.clock) throw Error("clock");
    expect(first.clock.highWaterMs).toBe(6000);
    expect(trustedNow(first.clock, { ...clockSample(), bootId: "new-process" })).toBeNull();
    wall = 9000;
    expect(trustedNow(first.clock, clockSample())).toBeNull();
    const next = await beginGrantRequest();
    if (!next) throw Error("lease");
    await installGrantConfiguration(next, {
      protocol: "offline-grants-v1",
      owner: { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 },
      serverTime: 7000,
      mode: "strict",
      policyRevision: "p1",
      keyset: null,
    });
    const recovered = await readGrantState();
    if (!recovered?.clock) throw Error("clock");
    expect(recovered.clock.wallHighWaterMs).toBe(9000);
    expect(trustedNow(recovered.clock, clockSample())).toBe(7000);
    expect(recovered.device?.grant.grantId).toBe("11111111-1111-4111-8111-111111111111");
  } finally {
    monoSpy.mockRestore();
    wallSpy.mockRestore();
  }
});
it("uses the configured API base path while trusting only its canonical origin", async () => {
  const { createKioskClient } = await import("../src/api/client.js");
  const { refreshGrants } = await import("../src/grants/sync.js");
  const cfg = await writeConfig({ ...config, serverUrl: origin + "/api" });
  const response = issued();
  response.envelope.serverTime = 2000;
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>)["x-kiosk-token"]).toBe("test-only");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      protocol: "offline-grants-v1",
      capability: "offline-grants-v1",
      requestId: expect.any(String),
    });
    const requestBody = JSON.parse(String(init?.body)) as { requestId: string };
    const body = String(url).endsWith("/readiness")
      ? {
          protocol: "offline-grants-v1",
          requestId: requestBody.requestId,
          receivedAt: "2026-09-14T12:00:00.000Z",
          accepted: true,
          matchesCurrentConfiguration: true,
          verifiedGrantMatched: true,
        }
      : String(url).endsWith("/configuration")
        ? {
            protocol: "offline-grants-v1",
            owner: response.envelope.owner,
            serverTime: 1000,
            mode: "strict",
            policyRevision: "approved",
            keyset,
          }
        : response;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  await refreshGrants(createKioskClient({ ...cfg, token: "test-only" }));
  expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
    origin + "/api/kiosk/grants/v1/configuration",
    origin + "/api/kiosk/grants/v1/device",
    origin + "/api/kiosk/grants/v1/readiness",
  ]);
  expect((await readGrantState())?.device?.grant.grantId).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
});

it("reopens and retries the exact durable kiosk readiness request before acknowledging it", async () => {
  const owner = (await import("../src/store/installation-binding.js")).boxRegistryCredentialOwnerOf(
    await writeConfig(config),
  );
  if (!owner) throw Error("owner");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantConfiguration(lease, {
    protocol: "offline-grants-v1",
    owner: { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 },
    serverTime: 1000,
    mode: "observe",
    policyRevision: "approved-v1",
    keyset,
  });
  await installGrantResponse(lease, issued());
  const intent = await prepareKioskGrantReadiness(owner);
  expect(intent?.body).toMatchObject({
    protocol: "offline-grants-v1",
    capability: "offline-grants-readiness-v1",
    clientBuild: "kiosk:0.1.0",
    storageRevision: 7,
    installed: {
      mode: "observe",
      policyRevision: "approved-v1",
      keysetRevision: "opaque-z",
      verifiedGrantId: "11111111-1111-4111-8111-111111111111",
    },
  });
  const sent: unknown[] = [];
  const client = {
    registryOwner: owner,
    grantReadiness: vi.fn(async (body: unknown) => {
      sent.push(body);
      if (sent.length === 1) throw new TypeError("response lost");
      const requestId = (body as { requestId: string }).requestId;
      return {
        protocol: "offline-grants-v1",
        requestId,
        receivedAt: "2026-09-14T12:00:00.000Z",
        accepted: true,
        matchesCurrentConfiguration: true,
        verifiedGrantMatched: true,
      };
    }),
  };
  await expect(flushKioskGrantReadiness(client)).rejects.toThrow("response lost");
  await expect(flushKioskGrantReadiness(client)).resolves.toBe(true);
  expect(sent[1]).toEqual(sent[0]);
  const { STORE_GRANT_READINESS, withStore } = await import("../src/store/db.js");
  expect(await withStore(STORE_GRANT_READINESS, "readonly", (store) => store.getAll())).toEqual([]);
});
it("keeps approved configuration mode when a later envelope disagrees", async () => {
  const { installGrantConfiguration } = await import("../src/grants/transport.js");
  const lease = await beginGrantRequest();
  if (!lease) throw Error("lease");
  await installGrantConfiguration(lease, {
    protocol: "offline-grants-v1",
    owner: { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 },
    serverTime: 1000,
    mode: "observe",
    policyRevision: "approved-observe",
    keyset,
  });
  const response = issued();
  response.envelope.serverTime = 2000;
  await installGrantResponse(lease, response);
  expect((await readGrantState())?.mode).toBe("observe");
});
it("persists authenticated strict and approved rollback despite untrusted clock readings", async () => {
  const { installGrantConfiguration } = await import("../src/grants/transport.js");
  const first = await beginGrantRequest();
  if (!first) throw Error("lease");
  const configuration = {
    protocol: "offline-grants-v1",
    owner: { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 },
    serverTime: 2000,
    mode: "observe",
    policyRevision: "approved-observe",
    keyset,
  };
  await installGrantConfiguration(first, configuration);
  const next = await beginGrantRequest();
  if (!next) throw Error("lease");
  expect(
    await installGrantConfiguration(next, {
      ...configuration,
      serverTime: 1000,
      mode: "strict",
      policyRevision: "approved-strict",
      owner: { ...configuration.owner, credentialEpoch: 8 },
    }),
  ).toBe(true);
  expect(await readGrantState()).toMatchObject({ mode: "strict", epoch: 8, clockTrusted: false });
  const last = await beginGrantRequest();
  if (!last) throw Error("lease");
  expect(
    await installGrantConfiguration(
      { ...last, started: { ...last.started, bootId: "different-process" } },
      { ...configuration, owner: { ...configuration.owner, credentialEpoch: 8 }, serverTime: 3000 },
    ),
  ).toBe(true);
  expect(await readGrantState()).toMatchObject({ mode: "observe", epoch: 8, clockTrusted: false });
});
it("prepares a strict confirmed draft through real signed task transport then completes offline after device expiry", async () => {
  // This fixture server is frozen at 1000; keep its monotonic timeline frozen too.
  const monotonic = vi.spyOn(performance, "now").mockReturnValue(100);
  try {
    const { createKioskClient } = await import("../src/api/client.js");
    const { readConfig } = await import("../src/store/config.js");
    const { withStore, STORE_SNAPSHOT, STORE_GRANTS } = await import("../src/store/db.js");
    const { installGrantConfiguration } = await import("../src/grants/transport.js");
    const { prepareStrictPickup } = await import("../src/grants/preparation.js");
    const { recoverPickupDraft } = await import("../src/grants/drafts.js");
    const { enqueueOrder, listQueue } = await import("../src/store/queue.js");
    const { canonical, sha256, orderContent } = await import("../src/grants/scope.js");
    const { validatePickupKm } = await import("@markiro/domain");
    const cfg = await readConfig();
    if (!cfg?.token) throw Error("config");
    const client = createKioskClient({ ...cfg, token: cfg.token }),
      owner = client.registryOwner;
    if (!owner) throw Error("owner");
    const rawKm = "010460068200001321KYC9X7MQ\u001d93Abcd",
      badgeDigest = "PGnhdQA2lW09CcvuOhCmvp0z4HbztWXaYIq7+dqmLoQ=",
      taskId = "00000000-0000-4000-8000-000000000003";
    const km = validatePickupKm(rawKm);
    if (km.status === "not_km" || km.status === "incomplete") throw Error("km");
    const employee = {
      id: "employee",
      fullName: "Employee",
      limitMode: "unlimited" as const,
      dayLimit: 0,
      canWriteoff: false,
    };
    await withStore(STORE_SNAPSHOT, "readwrite", (s) =>
      s.put(
        {
          bootstrap: {
            products: [{ id: "product", gtin14: km.km.gtin14 }],
            employees: [
              {
                ...employee,
                badgeHash: `pbkdf2$sha256$100000$fwGrIt01vwgBxxDlhqLVRQ==$${badgeDigest}`,
              },
            ],
            reasons: [],
            pickupPolicy: { limitsEnabled: false },
            config: { dayLimitPerEmployee: 0 },
          },
          fetchedAt: "fixture",
        },
        "current",
      ),
    );
    const lease = await beginGrantRequest();
    if (!lease) throw Error("lease");
    const grantOwner = { tenantId: "tenant", deviceId, kind: "kiosk", credentialEpoch: 7 };
    await installGrantConfiguration(lease, {
      protocol: "offline-grants-v1",
      owner: grantOwner,
      serverTime: 1000,
      mode: "strict",
      policyRevision: "approved",
      keyset,
    });
    await installGrantResponse(lease, issued());
    const confirmed = {
      screen: "confirmation" as const,
      submitting: false,
      session: {
        id: 1,
        badgeDigest,
        employee,
        cart: {
          reason: "buy" as const,
          writeoffReasonId: null,
          notice: null,
          lines: [
            {
              kind: "km" as const,
              rawKm,
              kmKey: km.key,
              gtin14: km.km.gtin14,
              serial: "KYC9X7MQ",
              productId: "product",
              name: "Product",
              unitPrice: null,
              bottleCount: 1 as const,
            },
          ],
        },
      },
    };
    let text = "",
      digest = "";
    client.reserveGrantOrder = vi.fn(async (request) => {
      expect(request.order).not.toHaveProperty("createdAt");
      expect(request.order.admissionNonce).toHaveLength(32);
      expect(await listQueue()).toEqual([]);
      expect((await readConfig())?.nextDeviceSeq).toBe(2);
      const scope = {
        version: 1,
        deviceSeq: 1,
        payloadDigest: await sha256(orderContent(request.order)),
        reason: "buy",
        writeoffReasonId: null,
        badgeIdentityDigest: await sha256(canonical({ badgeDigest, badgeCode: null })),
        items: [{ rawKm, kmKey: km.key, productId: "product" }],
        boxes: [],
        unitCount: 1,
        containerCount: 0,
      };
      text = canonical({ taskKind: "pickup", taskId, scope });
      digest = await sha256(text);
      return {
        status: "reserved",
        protocol: "offline-grants-v1",
        admission: { claimedAt: "2026-09-13T00:00:00Z", admissionProof: "opaque-proof" },
        task: { taskKind: "pickup", taskId, snapshotDigest: digest },
      };
    });
    client.issueTaskGrant = vi.fn(async () => {
      const payload = {
        ...grantOwner,
        version: 1,
        issuer: origin,
        grantId: "prepared-task",
        entitlementRevision: "e1",
        policyRevision: "p1",
        issuedAt: 1000,
        notBefore: 1000,
        kindOfGrant: "task",
        taskKind: "pickup",
        taskId,
        snapshotDigest: digest,
        completeNotAfter: 100000,
        eventTypes: ["pickup.complete.v1"],
        budget: [
          { id: "pickup.complete.v1:events", unit: "event", maximum: 1 },
          { id: "pickup.complete.v1:units", unit: "unit", maximum: 1 },
          { id: "pickup.complete.v1:containers", unit: "container", maximum: 0 },
        ],
      };
      const input = [{ typ: "markiro-offline-grant+jws", alg: "ES256", kid: "test-only" }, payload]
        .map((v) => Buffer.from(JSON.stringify(v)).toString("base64url"))
        .join(".");
      const compact =
        input +
        "." +
        sign("sha256", Buffer.from(input), {
          key: pair.privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url");
      return {
        status: "issued",
        envelope: {
          protocol: "offline-grants-v1",
          serverTime: 1000,
          owner: grantOwner,
          mode: "strict",
          grants: [compact],
          taskSnapshots: [{ taskKind: "pickup", taskId, snapshotDigest: digest, canonical: text }],
        },
      };
    });
    const prepared = await prepareStrictPickup(client, owner, confirmed, "2026-09-13T00:00:00Z");
    if (!prepared) throw Error("prepared");
    expect(await listQueue()).toEqual([]);
    const state = await readGrantState();
    if (!state?.device) throw Error("state");
    const device = state.device;
    await withStore(STORE_GRANTS, "readwrite", (s) =>
      s.put(
        {
          ...state,
          device: { ...device, grant: { ...device.grant, startNotAfter: 1000 } },
        },
        JSON.stringify(["state", origin, deviceId]),
      ),
    );
    const recovered = await recoverPickupDraft(owner, "employee", badgeDigest);
    expect(recovered?.cart).toEqual(confirmed.session.cart);
    const retried = await prepareStrictPickup(
      client,
      owner,
      { ...confirmed, session: { ...confirmed.session, id: 2 } },
      "2026-09-13T00:01:00Z",
    );
    expect(retried).toEqual(prepared);
    expect(client.reserveGrantOrder).toHaveBeenCalledTimes(1);
    expect(client.issueTaskGrant).toHaveBeenCalledTimes(1);
    await enqueueOrder(prepared, "employee", undefined, 1, owner);
    expect(await listQueue()).toMatchObject([
      { body: prepared, grantEvidence: { taskGrantId: "prepared-task", mode: "strict" } },
    ]);
  } finally {
    monotonic.mockRestore();
  }
});
