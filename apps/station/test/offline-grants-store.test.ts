import {
  prepareReplacementReadiness,
  applyReplacementClosure,
  acknowledgeReplacementClosure,
} from "../src/lib/device-replacement.js";
import { StationGrantAdmission } from "../src/lib/offline-grants/admission.js";
import { DatabaseSync } from "node:sqlite";
import fixtures from "../../../packages/platform-contracts/fixtures/offline-grants-v1.json" with { type: "json" };
import { STATION_MIGRATIONS } from "@markiro/db/station-sqlite";
import type { GrantKeyset } from "@markiro/platform-contracts";
import { describe, expect, it } from "vitest";
import {
  createCredentialGeneration,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery.js";
import type { SqlExecutor } from "../src/lib/mirror.js";
import type { StationClient } from "../src/lib/api-client.js";
import {
  installStationGrant,
  prepareStationGrantReadiness,
} from "../src/lib/offline-grants/store.js";
import {
  fetchStationDeviceGrant,
  fetchStationGrantConfiguration,
  fetchStationTaskGrant,
  refreshStationGrantConfiguration,
  refreshStationOfflineGrant,
  reportStationGrantReadiness,
  refreshStationTaskAuthority,
} from "../src/lib/offline-grants/transport.js";
import { assertExecutionScopeMatches } from "../src/lib/offline-grants/semantic.js";

describe("offline grant semantic binding", () => {
  const actual = {
    taskKind: "shift" as const,
    taskId: "task",
    scope: {
      shift: {
        id: "task",
        productId: "product",
        mode: "aggregation",
        lineId: null,
        counterpartyId: null,
        counterpartyName: "Counterparty",
        labelTemplateId: null,
        boxLabelTemplateId: "box",
        palletLabelTemplateId: null,
        validationPrintMode: null,
        allowPreviouslyAcceptedCodes: false,
        validationPrintVerification: null,
        validationPrintTemplateId: null,
        validationPrintSnapshot: null,
        validationPrintPolicyRevision: null,
        boxCapacity: 12,
        palletsEnabled: false,
        palletBoxCapacity: null,
        stationClosePolicy: null,
        stationCloseOwnerDeviceId: null,
        plannedDate: null,
        productionDate: null,
        number: "SEP26-007",
      },
      product: {
        id: "product",
        gtin14: "04600000000001",
        name: "Product",
        printName: null,
        egaisCode: null,
        shelfLifeDays: null,
      },
      templates: [{ id: "box", spec: { width: 10 } }],
    },
  };
  it("accepts server-only metadata while comparing every actual execution field", () => {
    expect(() =>
      assertExecutionScopeMatches(
        {
          taskKind: "shift",
          taskId: "task",
          scope: {
            shift: {
              ...actual.scope.shift,
              numberMonthKey: "SEP26",
              numberSeq: 7,
              createdFrom: "admin",
              ssccIssuerCounterpartyId: "server-only",
            },
            product: { ...actual.scope.product, chzProductGroupCode: "x" },
            templates: actual.scope.templates,
          },
        },
        actual,
      ),
    ).not.toThrow();
  });
  it("binds the explicit reprocessing policy and rejects changed or missing signed authority", () => {
    const signed = {
      taskKind: "shift",
      taskId: "task",
      scope: {
        ...actual.scope,
        shift: {
          ...actual.scope.shift,
          numberMonthKey: "SEP26",
          numberSeq: 7,
          createdFrom: "admin",
          allowPreviouslyAcceptedCodes: true,
        },
      },
    };
    expect(() => assertExecutionScopeMatches(signed, actual)).toThrow(/active shift mismatch/);
    const enabled = {
      ...actual,
      scope: {
        ...actual.scope,
        shift: { ...actual.scope.shift, allowPreviouslyAcceptedCodes: true },
      },
    };
    expect(() => assertExecutionScopeMatches(signed, enabled)).not.toThrow();
    const missing: Record<string, unknown> = { ...signed.scope.shift };
    delete missing.allowPreviouslyAcceptedCodes;
    expect(() =>
      assertExecutionScopeMatches(
        { ...signed, scope: { ...signed.scope, shift: missing } },
        actual,
      ),
    ).toThrow(/active shift mismatch/);
  });
  it("rejects an incomplete caller projection instead of treating its keys as a whitelist", () => {
    expect(() =>
      assertExecutionScopeMatches(
        {
          taskKind: "shift",
          taskId: "task",
          scope: {
            shift: {
              ...actual.scope.shift,
              numberMonthKey: "SEP26",
              numberSeq: 7,
              createdFrom: "admin",
            },
            product: actual.scope.product,
            templates: actual.scope.templates,
          },
        },
        {
          taskKind: "shift",
          taskId: "task",
          scope: { shift: {}, product: {}, templates: [] },
        } as never,
      ),
    ).toThrow(/active shift mismatch/);
  });
  it("rejects changed active execution facts under the same task id", () => {
    expect(() =>
      assertExecutionScopeMatches(
        {
          taskKind: "shift",
          taskId: "task",
          scope: { ...actual.scope, shift: { ...actual.scope.shift, boxCapacity: 13 } },
        },
        actual,
      ),
    ).toThrow(/active shift mismatch/);
  });
  it("rejects a stale legacy cache missing an active template", () => {
    expect(() =>
      assertExecutionScopeMatches(
        { taskKind: "shift", taskId: "task", scope: { ...actual.scope, templates: [] } },
        actual,
      ),
    ).toThrow(/active shift mismatch/);
  });
  it("binds the complete active inventory manifest", () => {
    const inventory = {
      taskKind: "inventory" as const,
      taskId: "i",
      scope: {
        manifest: { mode: "check" },
        snapshotId: "s",
        combinedDigest: "c",
        contentDigest: "d",
      },
    };
    expect(() =>
      assertExecutionScopeMatches(
        {
          taskKind: "inventory",
          taskId: "i",
          scope: { ...inventory.scope, manifest: { mode: "repack" } },
        },
        inventory,
      ),
    ).toThrow(/active inventory mismatch/);
  });
});

function migratedExec(): { db: DatabaseSync; exec: SqlExecutor } {
  const db = new DatabaseSync(":memory:");
  for (const sql of STATION_MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  return {
    db,
    exec: {
      async run(sql: string, params: unknown[] = []) {
        db.prepare(sql).run(...(params as never[]));
      },
      async all<T>(sql: string, params: unknown[] = []) {
        return db.prepare(sql).all(...(params as never[])) as T[];
      },
    },
  };
}

function issuerClient(keyset: unknown, response: unknown): Pick<StationClient, "get" | "post"> {
  return {
    async get<T>() {
      return keyset as T;
    },
    async post<T>() {
      return response as T;
    },
  };
}

describe("signed Station grant installation", () => {
  const origin = "https://offline-grants.fixture.invalid";
  const owner = {
    tenantId: "fixture-tenant",
    deviceId: "fixture-device",
    kind: "station" as const,
    credentialEpoch: 1,
  };
  const producer = fixtures.producers.find((candidate) => candidate.id === "device");
  if (!producer) throw new Error("missing device fixture");
  const readinessGrantId = "11111111-1111-4111-8111-111111111111";
  const keyset = {
    protocol: "offline-grants-v1" as const,
    origin,
    revision: "fixture-r1",
    keys: [
      {
        kid: fixtures.publicKey.kid,
        jwk: {
          kty: "EC",
          crv: "P-256",
          x: fixtures.publicKey.jwk.x,
          y: fixtures.publicKey.jwk.y,
        },
      },
    ],
    retiredKids: [],
  } satisfies GrantKeyset;
  const envelope = {
    protocol: "offline-grants-v1" as const,
    serverTime: 1_800_000_000_000,
    owner,
    mode: "observe" as const,
    grants: [producer.compact],
    taskSnapshots: [],
  };

  async function installedReadinessFixture() {
    const state = migratedExec();
    const generation = createCredentialGeneration("fixture-secret");
    await installStationGrant({
      exec: state.exec,
      envelope,
      keyset,
      configuredOrigin: origin,
      generation,
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      requestSequence: 1,
      clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
    });
    state.db
      .prepare(
        "UPDATE offline_grant_grants SET grant_id=?,grant_json=json_set(grant_json,'$.grantId',?)",
      )
      .run(readinessGrantId, readinessGrantId);
    state.db
      .prepare(
        `INSERT INTO offline_grant_configuration
          (id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode,policy_revision)
         VALUES(1,?,?,?,?,1,'observe','fixture-p1')`,
      )
      .run(owner.tenantId, owner.deviceId, owner.kind, owner.credentialEpoch);
    return { ...state, generation };
  }

  it("cannot reinstall new-work authority from a delayed signed grant after durable drain", async () => {
    const { db, exec, generation } = await installedReadinessFixture();
    await prepareReplacementReadiness({
      exec,
      generation,
      expectedDevice: owner,
      intent: {
        intentId: "22222222-2222-4222-8222-222222222222",
        preparationId: "33333333-3333-4333-8333-333333333333",
        credentialEpoch: 1,
        preparationRevision: 2,
        requestedAt: "2026-09-16T10:00:00Z",
        expiresAt: "2026-09-16T10:05:00Z",
      },
    });
    await installStationGrant({
      exec,
      envelope,
      keyset,
      configuredOrigin: origin,
      generation,
      expectedDevice: owner,
      requestSequence: 3,
      clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) count FROM offline_grant_grants WHERE json_extract(grant_json,'$.kindOfGrant')='device'",
        )
        .get(),
    ).toEqual({ count: 0 });
    // A late configuration may still update the authenticated rollout mode;
    // it cannot override the independent durable replacement fence.
    db.exec(
      "UPDATE offline_grant_install_state SET mode='observe'; UPDATE offline_grant_configuration SET mode='observe'",
    );
    const admission = new StationGrantAdmission(exec, async () => ({
      bootId: "boot",
      monotonicMs: 10,
      wallMs: 20,
    }));
    expect(
      (
        await admission.assessNewWork({
          owner,
          capability: "shift.start.v1",
          taskId: "task",
          snapshotDigest: "start",
          eventId: "entry",
          eventType: "shift.scan.v1",
          cost: {},
        })
      ).allow,
    ).toBe(false);
    await applyReplacementClosure({
      exec,
      generation,
      tombstone: {
        version: 1,
        state: "cancelled",
        intentId: "22222222-2222-4222-8222-222222222222",
        preparationId: "33333333-3333-4333-8333-333333333333",
        credentialEpoch: 1,
        preparationRevision: 3,
        closedAt: "2026-09-16T10:02:00Z",
      },
    });
    const floor = (
      await exec.all<{ grant_install_floor: number }>(
        "SELECT grant_install_floor FROM device_replacement_drain",
      )
    )[0]?.grant_install_floor;
    if (floor === undefined) throw new Error("missing grant floor");
    expect(
      await installStationGrant({
        exec,
        envelope,
        keyset,
        configuredOrigin: origin,
        generation,
        expectedDevice: owner,
        requestSequence: floor,
        clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
      }),
    ).toBe(false);
    await refreshStationOfflineGrant({
      exec,
      client: issuerClient(keyset, { status: "issued", envelope }),
      configuredOrigin: origin,
      generation,
      expectedDevice: owner,
      sampleClock: async () => ({ bootId: "boot", monotonicMs: 10, wallMs: 20 }),
    });
    expect(
      db
        .prepare(
          "SELECT count(*) count FROM offline_grant_grants WHERE json_extract(grant_json,'$.kindOfGrant')='device'",
        )
        .get(),
    ).toEqual({ count: 0 });
    const [pending] = await exec.all<{ sequence: number }>(
      "SELECT MAX(request_sequence)+1 sequence FROM offline_grant_install_commands",
    );
    if (!pending) throw new Error("missing pending sequence");
    await acknowledgeReplacementClosure({
      exec,
      generation,
      client: {
        post: async (_path, body) => ({
          ...(body as object),
          acknowledgedAt: "2026-09-16T10:03:00Z",
        }),
      },
    });
    expect(
      await installStationGrant({
        exec,
        envelope,
        keyset,
        configuredOrigin: origin,
        generation,
        expectedDevice: owner,
        requestSequence: pending.sequence,
        clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
      }),
    ).toBe(false);
    await refreshStationOfflineGrant({
      exec,
      client: issuerClient(keyset, { status: "issued", envelope }),
      configuredOrigin: origin,
      generation,
      expectedDevice: owner,
      sampleClock: async () => ({ bootId: "boot", monotonicMs: 10, wallMs: 20 }),
    });
    expect(
      db
        .prepare("SELECT count(*) count FROM offline_grant_grants WHERE installed_sequence>?")
        .get(floor),
    ).toEqual({ count: 1 });
    expect(
      (
        await admission.assessNewWork({
          owner,
          capability: "shift.start.v1",
          taskId: "task",
          snapshotDigest: "start",
          eventId: "entry",
          eventType: "shift.scan.v1",
          cost: {},
        })
      ).allow,
    ).toBe(true);
  });

  it("builds readiness only from configuration, keyset and a verified device grant reread from SQLite", async () => {
    const { db, exec, generation } = await installedReadinessFixture();
    const intent = await prepareStationGrantReadiness({
      exec,
      configuredOrigin: origin,
      generation,
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      clientBuild: "station:0.1.0",
    });
    expect(intent?.body).toMatchObject({
      protocol: "offline-grants-v1",
      capability: "offline-grants-readiness-v1",
      clientBuild: "station:0.1.0",
      storageRevision: 1,
      installed: {
        mode: "observe",
        policyRevision: "fixture-p1",
        keysetRevision: "fixture-r1",
        verifiedGrantId: readinessGrantId,
      },
    });
    expect(db.prepare("SELECT count(*) count FROM offline_grant_readiness_outbox").get()).toEqual({
      count: 1,
    });
  });

  it("retries a lost readiness response with the same durable request identity and body", async () => {
    const { db, exec, generation } = await installedReadinessFixture();
    const bodies: unknown[] = [];
    let fail = true;
    const client: Pick<StationClient, "get" | "post"> = {
      async get<T>() {
        return keyset as T;
      },
      async post<T>(path: string, body?: unknown) {
        if (path === "/station/grants/v1/readiness") {
          bodies.push(body);
          if (fail) {
            fail = false;
            throw new Error("response lost");
          }
          const requestId = (body as { requestId: string }).requestId;
          return {
            protocol: "offline-grants-v1",
            requestId,
            receivedAt: "2026-09-14T12:00:00.000Z",
            accepted: true,
            matchesCurrentConfiguration: true,
            verifiedGrantMatched: true,
          } as T;
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const input = {
      exec,
      client,
      configuredOrigin: origin,
      generation,
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      clientBuild: "station:0.1.0",
    } as const;
    await expect(reportStationGrantReadiness(input)).rejects.toThrow("response lost");
    await expect(reportStationGrantReadiness(input)).resolves.toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(
      db
        .prepare(
          "SELECT attempts,acknowledged_at IS NOT NULL acknowledged FROM offline_grant_readiness_outbox",
        )
        .get(),
    ).toEqual({ attempts: 2, acknowledged: 1 });
  });

  it("drains a lost readiness intent before refreshing configuration on the next run", async () => {
    const { exec, generation } = await installedReadinessFixture();
    const bodies: Array<{ requestId: string; installed: { policyRevision: string | null } }> = [];
    let loseFirstResponse = true;
    const client: Pick<StationClient, "get" | "post"> = {
      async get<T>() {
        return keyset as T;
      },
      async post<T>(path: string, body?: unknown) {
        if (path !== "/station/grants/v1/readiness") throw new Error(`unexpected ${path}`);
        const readiness = body as (typeof bodies)[number];
        bodies.push(readiness);
        if (loseFirstResponse) {
          loseFirstResponse = false;
          throw new Error("response lost");
        }
        return {
          protocol: "offline-grants-v1",
          requestId: readiness.requestId,
          receivedAt: "2026-09-14T12:00:00.000Z",
          accepted: true,
          matchesCurrentConfiguration: true,
          verifiedGrantMatched: true,
        } as T;
      },
    };
    const input = {
      exec,
      client,
      configuredOrigin: origin,
      generation,
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      clientBuild: "station:0.1.0",
    } as const;
    let configurationRefreshes = 0;
    const run = async () => {
      const pending = await prepareStationGrantReadiness(input);
      if (pending) await reportStationGrantReadiness({ ...input, intent: pending });
      configurationRefreshes += 1;
      await exec.run("UPDATE offline_grant_keysets SET revision='fixture-r2'");
      await reportStationGrantReadiness(input);
    };

    await expect(run()).rejects.toThrow("response lost");
    expect(configurationRefreshes).toBe(0);
    await expect(run()).resolves.toBeUndefined();
    expect(configurationRefreshes).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toMatchObject({ installed: { keysetRevision: "fixture-r2" } });
    expect(bodies[2]?.requestId).not.toBe(bodies[0]?.requestId);
  });

  it("does not create or send readiness after the credential generation is sealed", async () => {
    const { db, exec, generation } = await installedReadinessFixture();
    await sealCredentialGeneration(generation);
    const client = { post: async () => Promise.reject(new Error("must not send")) };
    await expect(
      reportStationGrantReadiness({
        exec,
        client,
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        clientBuild: "station:0.1.0",
      }),
    ).resolves.toBe(false);
    expect(db.prepare("SELECT count(*) count FROM offline_grant_readiness_outbox").get()).toEqual({
      count: 0,
    });
  });

  it("does not send readiness when the durable intent cannot be stored", async () => {
    const { exec, generation } = await installedReadinessFixture();
    const failingExec: SqlExecutor = {
      all: exec.all.bind(exec),
      async run(sql, params) {
        if (sql.includes("INSERT OR IGNORE INTO offline_grant_readiness_outbox")) {
          throw new Error("sqlite write failed");
        }
        return exec.run(sql, params);
      },
    };
    const post = vi.fn();
    await expect(
      reportStationGrantReadiness({
        exec: failingExec,
        client: { post },
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        clientBuild: "station:0.1.0",
      }),
    ).rejects.toThrow("sqlite write failed");
    expect(post).not.toHaveBeenCalled();
  });

  it("verifies committed fixture bytes and atomically installs under the current credential generation", async () => {
    const { db, exec } = migratedExec();
    const generation = createCredentialGeneration("fixture-secret");
    expect(
      await installStationGrant({
        exec,
        envelope,
        keyset,
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        requestSequence: 1,
        clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
      }),
    ).toBe(true);
    expect(db.prepare("SELECT grant_id,compact FROM offline_grant_grants").get()).toEqual({
      grant_id: "fixture-grant-device",
      compact: producer.compact,
    });
  });

  it("does not persist a verified response after its credential generation is sealed", async () => {
    const { db, exec } = migratedExec();
    const generation = createCredentialGeneration("fixture-secret");
    await sealCredentialGeneration(generation);
    expect(
      await installStationGrant({
        exec,
        envelope,
        keyset,
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        requestSequence: 1,
        clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
      }),
    ).toBe(false);
    expect(
      db.prepare("SELECT count(*) AS count FROM offline_grant_install_commands").get(),
    ).toEqual({
      count: 0,
    });
  });

  it("ages a delayed issuer response from request start and rejects a boot change", async () => {
    const first = migratedExec();
    const samples = [
      { bootId: "boot", monotonicMs: 10, wallMs: 20 },
      { bootId: "boot", monotonicMs: 110, wallMs: 120 },
    ];
    await refreshStationOfflineGrant({
      exec: first.exec,
      client: issuerClient(keyset, { status: "issued", envelope }),
      configuredOrigin: origin,
      generation: createCredentialGeneration("fixture-secret"),
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      sampleClock: async () => samples.shift()!,
    });
    expect(
      first.db.prepare("SELECT monotonic_ms,wall_high_water_ms FROM offline_grant_clock").get(),
    ).toEqual({
      monotonic_ms: 10,
      wall_high_water_ms: 120,
    });

    const second = migratedExec();
    const changed = [
      { bootId: "before", monotonicMs: 10, wallMs: 20 },
      { bootId: "after", monotonicMs: 1, wallMs: 21 },
    ];
    await expect(
      refreshStationOfflineGrant({
        exec: second.exec,
        client: issuerClient(keyset, { status: "issued", envelope }),
        configuredOrigin: origin,
        generation: createCredentialGeneration("fixture-secret"),
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        sampleClock: async () => changed.shift()!,
      }),
    ).rejects.toThrow(/boot changed/);
    expect(
      second.db.prepare("SELECT count(*) count FROM offline_grant_install_commands").get(),
    ).toEqual({ count: 0 });
  });

  it("persists key retirement even when productive issuance is denied", async () => {
    const { db, exec } = migratedExec();
    const generation = createCredentialGeneration("fixture-secret");
    await installStationGrant({
      exec,
      envelope,
      keyset,
      configuredOrigin: origin,
      generation,
      expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
      requestSequence: 1,
      clock: { serverMs: envelope.serverTime, monotonicMs: 10, bootId: "boot", wallMs: 20 },
    });
    const retired = { ...keyset, revision: "fixture-r2", retiredKids: [fixtures.publicKey.kid] };
    await expect(
      refreshStationOfflineGrant({
        exec,
        client: issuerClient(retired, { status: "denied", reason: "not_entitled" }),
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        sampleClock: async () => ({ bootId: "boot", monotonicMs: 20, wallMs: 30 }),
      }),
    ).resolves.toEqual({ status: "denied", reason: "not_entitled" });
    expect(db.prepare("SELECT kid FROM offline_grant_retired_kids").all()).toEqual([
      { kid: fixtures.publicKey.kid },
    ]);
    expect(db.prepare("SELECT count(*) count FROM offline_grant_grants").get()).toEqual({
      count: 0,
    });

    await expect(
      installStationGrant({
        exec,
        envelope,
        keyset,
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        requestSequence: 3,
        clock: { serverMs: envelope.serverTime, monotonicMs: 30, bootId: "boot", wallMs: 40 },
      }),
    ).rejects.toThrow(/verification failed/);
    expect(db.prepare("SELECT count(*) count FROM offline_grant_grants").get()).toEqual({
      count: 0,
    });
  });

  it("does not persist a denied response keyset after credential retirement", async () => {
    const { db, exec } = migratedExec();
    const generation = createCredentialGeneration("fixture-secret");
    const client = {
      async get<T>() {
        await sealCredentialGeneration(generation);
        return keyset as T;
      },
      async post<T>() {
        return { status: "denied", reason: "not_entitled" } as T;
      },
    };
    await expect(
      refreshStationOfflineGrant({
        exec,
        client,
        configuredOrigin: origin,
        generation,
        expectedDevice: { tenantId: owner.tenantId, deviceId: owner.deviceId, kind: owner.kind },
        sampleClock: async () => ({ bootId: "boot", monotonicMs: 20, wallMs: 30 }),
      }),
    ).rejects.toThrow(/stale credential/);
    expect(db.prepare("SELECT count(*) count FROM offline_grant_keysets").get()).toEqual({
      count: 0,
    });
  });
});

describe("Station issuer response negotiation", () => {
  it("requests device then task authority for new work and skips new-work authority on resume", async () => {
    const calls: string[] = [];
    const scope = {
      shift: {
        id: "shift",
        productId: "product",
        mode: "aggregation",
        lineId: null,
        counterpartyId: null,
        counterpartyName: null,
        labelTemplateId: null,
        boxLabelTemplateId: null,
        palletLabelTemplateId: null,
        validationPrintMode: null,
        allowPreviouslyAcceptedCodes: false,
        validationPrintVerification: null,
        validationPrintTemplateId: null,
        validationPrintSnapshot: null,
        validationPrintPolicyRevision: null,
        boxCapacity: 12,
        palletsEnabled: false,
        palletBoxCapacity: null,
        stationClosePolicy: null,
        stationCloseOwnerDeviceId: null,
        plannedDate: null,
        productionDate: null,
        number: "SEP26-001",
      },
      product: {
        id: "product",
        gtin14: "04600000000001",
        name: "Product",
        printName: null,
        egaisCode: null,
        shelfLifeDays: null,
      },
      templates: [],
    };
    const exec = (resuming: boolean, changed = false): SqlExecutor => ({
      async run() {},
      async all<T>(sql: string) {
        if (sql.includes("FROM offline_grant_grants grant")) {
          expect(sql).toContain("JOIN offline_grant_task_admissions admission");
          return (
            resuming
              ? [
                  {
                    snapshot_digest: "digest",
                    scope_json: JSON.stringify({
                      ...scope,
                      shift: {
                        ...scope.shift,
                        numberMonthKey: "SEP26",
                        numberSeq: 1,
                        createdFrom: "admin",
                      },
                    }),
                  },
                ]
              : []
          ) as T[];
        }
        if (sql.includes("FROM shift_mirror"))
          return [
            {
              execution_scope_json: JSON.stringify(
                changed ? { ...scope, product: { ...scope.product, name: "Changed" } } : scope,
              ),
            },
          ] as T[];
        return [];
      },
    });
    const base = {
      client: issuerClient({}, {}),
      configuredOrigin: "https://offline-grants.fixture.invalid",
      generation: createCredentialGeneration("fixture-secret"),
      expectedDevice: { tenantId: "tenant", deviceId: "device", kind: "station" as const },
      task: { taskKind: "shift" as const, taskId: "shift" },
    };
    const refresh: typeof refreshStationOfflineGrant = async (input) => {
      calls.push(input.task ? `${input.task.taskKind}:${input.task.taskId}` : "device");
      return { status: "denied", reason: "not_entitled" };
    };
    await expect(
      refreshStationTaskAuthority({ ...base, exec: exec(false) }, refresh),
    ).resolves.toEqual({ resuming: false });
    expect(calls).toEqual(["device", "shift:shift"]);

    calls.length = 0;
    await refreshStationTaskAuthority({ ...base, exec: exec(false) }, refresh);
    await refreshStationTaskAuthority({ ...base, exec: exec(false) }, refresh);
    expect(calls).toEqual(["device", "shift:shift", "device", "shift:shift"]);

    calls.length = 0;
    await expect(
      refreshStationTaskAuthority({ ...base, exec: exec(true) }, refresh),
    ).resolves.toEqual({ resuming: true });
    expect(calls).toEqual(["shift:shift"]);

    calls.length = 0;
    await expect(
      refreshStationTaskAuthority({ ...base, exec: exec(true, true) }, refresh),
    ).resolves.toEqual({ resuming: false });
    expect(calls).toEqual(["device", "shift:shift"]);

    await expect(
      refreshStationTaskAuthority({ ...base, exec: exec(true) }, async () => {
        throw new Error("offline");
      }),
    ).resolves.toEqual({ resuming: true });
  });

  it("establishes fresh strict state even when the clock becomes untrusted", async () => {
    const { db, exec } = migratedExec();
    const configuration = {
      protocol: "offline-grants-v1" as const,
      owner: {
        tenantId: "fixture-tenant",
        deviceId: "fixture-device",
        kind: "station" as const,
        credentialEpoch: 1,
      },
      serverTime: 1_800_000_000_000,
      mode: "strict" as const,
      policyRevision: "approved-1",
      keyset: null,
    };
    const samples = [
      { bootId: "before", monotonicMs: 10, wallMs: 20 },
      { bootId: "after", monotonicMs: 1, wallMs: 21 },
    ];
    await refreshStationGrantConfiguration({
      exec,
      client: {
        async post<T>() {
          return configuration as T;
        },
      },
      configuredOrigin: "https://offline-grants.fixture.invalid",
      generation: createCredentialGeneration("fixture-secret"),
      expectedDevice: { tenantId: "fixture-tenant", deviceId: "fixture-device", kind: "station" },
      sampleClock: async () => samples.shift()!,
    });
    expect(db.prepare("SELECT mode FROM offline_grant_install_state WHERE id=1").get()).toEqual({
      mode: "strict",
    });
    expect(db.prepare("SELECT count(*) count FROM offline_grant_clock").get()).toEqual({
      count: 0,
    });
  });

  it("consumes the exact authenticated configuration route and preserves strict without an approved policy", async () => {
    const { db, exec } = migratedExec();
    db.exec(`INSERT INTO offline_grant_install_state(id,tenant_id,device_id,owner_kind,credential_epoch,request_sequence,mode)
      VALUES(1,'fixture-tenant','fixture-device','station',1,0,'strict')`);
    const configuration = {
      protocol: "offline-grants-v1" as const,
      owner: {
        tenantId: "fixture-tenant",
        deviceId: "fixture-device",
        kind: "station" as const,
        credentialEpoch: 1,
      },
      serverTime: 1_800_000_000_000,
      mode: "observe" as const,
      policyRevision: null,
      keyset: null,
    };
    const calls: unknown[] = [];
    const client = {
      async post<T>(path: string, body: unknown) {
        calls.push({ path, body });
        return configuration as T;
      },
    };
    await refreshStationGrantConfiguration({
      exec,
      client,
      configuredOrigin: "https://offline-grants.fixture.invalid",
      generation: createCredentialGeneration("fixture-secret"),
      expectedDevice: { tenantId: "fixture-tenant", deviceId: "fixture-device", kind: "station" },
      sampleClock: async () => ({ bootId: "boot", monotonicMs: 10, wallMs: 20 }),
    });
    expect(
      db.prepare("SELECT mode,policy_revision FROM offline_grant_configuration WHERE id=1").get(),
    ).toEqual({ mode: "strict", policy_revision: null });
    expect(db.prepare("SELECT mode FROM offline_grant_install_state WHERE id=1").get()).toEqual({
      mode: "strict",
    });
    expect(calls).toEqual([
      {
        path: "/station/grants/v1/configuration",
        body: expect.objectContaining({
          protocol: "offline-grants-v1",
          capability: "offline-grants-v1",
        }),
      },
    ]);
  });

  it("parses the configuration DTO instead of an issuance wrapper", async () => {
    const configuration = {
      protocol: "offline-grants-v1",
      owner: { tenantId: "t", deviceId: "d", kind: "station", credentialEpoch: 1 },
      serverTime: 1,
      mode: "observe",
      policyRevision: null,
      keyset: null,
    };
    await expect(
      fetchStationGrantConfiguration(
        {
          async post<T>() {
            return configuration as T;
          },
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toEqual(configuration);
  });

  it("consumes the route's discriminated issued wrapper and sends the exact task negotiation", async () => {
    const producer = fixtures.producers.find((candidate) => candidate.id === "device");
    if (!producer) throw new Error("missing device fixture");
    const envelope = {
      protocol: "offline-grants-v1" as const,
      serverTime: 1_800_000_000_000,
      owner: {
        tenantId: "fixture-tenant",
        deviceId: "fixture-device",
        kind: "station" as const,
        credentialEpoch: 1,
      },
      mode: "observe" as const,
      grants: [producer.compact],
      taskSnapshots: [],
    };
    const calls: unknown[] = [];
    const result = await fetchStationTaskGrant(
      {
        async post<T>(path: string, body: unknown) {
          calls.push({ path, body });
          return { status: "issued", envelope } as T;
        },
      },
      { requestId: "00000000-0000-4000-8000-000000000001", taskKind: "shift", taskId: "shift" },
    );
    expect(result).toEqual({ status: "issued", envelope });
    expect(calls).toEqual([
      {
        path: "/station/grants/v1/tasks",
        body: {
          protocol: "offline-grants-v1",
          capability: "offline-grants-v1",
          requestId: "00000000-0000-4000-8000-000000000001",
          taskKind: "shift",
          taskId: "shift",
        },
      },
    ]);
  });

  it("preserves the route's denied branch instead of treating it as an envelope", async () => {
    await expect(
      fetchStationDeviceGrant(
        {
          async post<T>() {
            return { status: "denied", reason: "not_entitled" } as T;
          },
        },
        "00000000-0000-4000-8000-000000000001",
      ),
    ).resolves.toEqual({ status: "denied", reason: "not_entitled" });
  });
});
