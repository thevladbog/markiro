// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openProductLabelWork } from "./support/product-label-work.js";
import {
  initializeDeviceRecovery,
  sealDeviceRecovery,
  restoreDeviceRecovery,
  readDeviceRecovery,
  credentialOwnsRetainedWork,
} from "../src/lib/device-recovery.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
} from "../src/lib/credential-recovery.js";
import { restoreProductLabelWork } from "../src/lib/product-labels/recovery.js";
import {
  appendProductLabelEvent,
  nextProductLabelEventBase,
  requireProductLabelJob,
} from "../src/lib/product-labels/store.js";
import { redeemStationRecovery } from "../src/lib/pairing.js";
import type { StationConfig } from "../src/lib/config.js";
let work: Awaited<ReturnType<typeof openProductLabelWork>>;
let config: StationConfig;
let generation: ReturnType<typeof createCredentialGeneration>;
beforeEach(async () => {
  generation = createCredentialGeneration("key-a");
  const hash = await credentialGenerationOwnership(generation);
  if (!hash) throw new Error("missing hash");
  work = await openProductLabelWork("required", hash, true, true);
  config = {
    machineId: "local",
    tenantId: "tenant",
    deviceId: work.input.deviceId,
    serverUrl: "https://api.example/api",
    apiKey: "key-a",
  };
});
afterEach(() => {
  work.close();
  vi.unstubAllGlobals();
});
const provisioning = () => ({
  deviceId: work.input.deviceId,
  tenantId: "tenant",
  serverUrl: "https://api.example/api",
  apiKey: "key-b",
  deviceName: "Station",
  organizationName: "Org",
  operators: [],
});
it("retains an unresolved legacy database without adopting it during another pairing", async () => {
  const view = await initializeDeviceRecovery(work.exec, { machineId: "local" });
  expect(view.phase).toBe("owner_unresolved");
  const retry = await initializeDeviceRecovery(work.exec, config);
  expect(retry.phase).toBe("owner_unresolved");
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
});
it("recovers interrupted sending as unknown under the new key without printing", async () => {
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  const job = await requireProductLabelJob(
    work.exec,
    work.input.credentialOwnership,
    work.input.jobId,
  );
  await appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
    ...nextProductLabelEventBase(job, work.actor),
    kind: "sending",
  });
  await sealDeviceRecovery(work.exec, config, generation);
  await restoreDeviceRecovery(work.exec, view.owner, provisioning(), async () => {});
  work.restart();
  const hash = await credentialGenerationOwnership(createCredentialGeneration("key-b"));
  if (!hash) throw new Error("missing hash");
  expect((await restoreProductLabelWork(work.exec, hash, work.actor))?.attemptState).toBe(
    "delivery_unknown",
  );
  expect(work.print).not.toHaveBeenCalled();
  expect(await credentialOwnsRetainedWork(work.exec, work.input.credentialOwnership, hash)).toBe(
    false,
  );
});
it.each([false, true])("reconciles crash after config publication=%s", async (published) => {
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  await sealDeviceRecovery(work.exec, config, generation);
  let disk = { ...config };
  await expect(
    restoreDeviceRecovery(work.exec, view.owner, provisioning(), async (next) => {
      if (published) disk = next;
      throw new Error("power interrupted");
    }),
  ).rejects.toThrow();
  expect((await readDeviceRecovery(work.exec))?.phase).toBe("restoring");
  work.restart();
  expect((await initializeDeviceRecovery(work.exec, disk)).phase).toBe(
    published ? "active" : "sealed",
  );
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
});
it.each([404, 405])("old API %s requires update and never falls back", async (status) => {
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  const fetch = vi.fn(async (_input: RequestInfo | URL) => new Response("{}", { status }));
  vi.stubGlobal("fetch", fetch);
  expect(await redeemStationRecovery("https://api.example/api", "12345678", view.owner)).toEqual({
    ok: false,
    error: "update_required",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(String(fetch.mock.calls[0]?.[0])).toContain("/station/pair/recovery");
});
it("atomically refuses a second unit under B while A still has unresolved printing", async () => {
  const { recordProductLabelAcceptance } = await import("../src/lib/product-labels/acceptance.js");
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  await sealDeviceRecovery(work.exec, config, generation);
  await restoreDeviceRecovery(work.exec, view.owner, provisioning(), async () => {});
  const hash = await credentialGenerationOwnership(createCredentialGeneration("key-b"));
  if (!hash) throw new Error("missing hash");
  const jobId = crypto.randomUUID();
  await expect(
    recordProductLabelAcceptance(work.exec, {
      ...work.input,
      credentialOwnership: hash,
      jobId,
      preparedEvent: { ...work.input.preparedEvent, jobId, eventId: crypto.randomUUID() },
    }),
  ).resolves.toEqual({ status: "busy" });
  expect(await work.exec.all("SELECT * FROM product_label_jobs")).toHaveLength(1);
});
it("persists sealing intent before waiting for an issued commit lease", async () => {
  const { acquireCredentialCommitLease, rejectCredentialGeneration } =
    await import("../src/lib/credential-recovery.js");
  const { persistDeviceRecoverySealing } = await import("../src/lib/device-recovery.js");
  await initializeDeviceRecovery(work.exec, config);
  const current = createCredentialGeneration("key-a", (gen) =>
    persistDeviceRecoverySealing(work.exec, config, gen),
  );
  const lease = acquireCredentialCommitLease(current);
  if (!lease) throw new Error("missing lease");
  const rejected = rejectCredentialGeneration({ machineId: config.machineId, generation: current });
  await vi.waitFor(async () =>
    expect((await readDeviceRecovery(work.exec))?.phase).toBe("sealing"),
  );
  lease.release();
  await rejected;
  work.restart();
  expect((await initializeDeviceRecovery(work.exec, config)).phase).toBe("sealed");
});
it.each(["tenant", "device", "origin", "kind", "version", "extra", "lost"])(
  "rejects %s recovery responses before local publication",
  async (fault) => {
    const view = await initializeDeviceRecovery(work.exec, config);
    if (!view.owner) throw new Error("missing owner");
    await sealDeviceRecovery(work.exec, config, generation);
    const before = await work.exec.all("SELECT * FROM station_device_recovery");
    const response = {
      version: fault === "version" ? 2 : 1,
      device: {
        id: fault === "device" ? crypto.randomUUID() : work.input.deviceId,
        kind: fault === "kind" ? "handheld" : "station",
        name: "Station",
        tenantId: fault === "tenant" ? "foreign" : "tenant",
        organizationName: "Org",
        line: null,
      },
      credential: {
        apiKey: "key-b",
        serverUrl: fault === "origin" ? "https://foreign.example" : "https://api.example/api",
      },
      operators: [],
      ...(fault === "extra" ? { unexpected: true } : {}),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        if (fault === "lost") throw new Error("lost response");
        return Response.json(response);
      }),
    );
    const result = await redeemStationRecovery("https://api.example/api", "12345678", view.owner);
    expect(result.ok).toBe(false);
    expect(await work.exec.all("SELECT * FROM station_device_recovery")).toEqual(before);
    expect(await work.exec.all("SELECT * FROM product_label_jobs")).toHaveLength(1);
  },
);
it("keeps conflicting saved credential hashes unresolved even with a complete config", async () => {
  expect(
    (await initializeDeviceRecovery(work.exec, { ...config, apiKey: "different-key" })).phase,
  ).toBe("owner_unresolved");
});
it("late sealing of key A cannot mutate the active restored key B", async () => {
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  await sealDeviceRecovery(work.exec, config, generation);
  await restoreDeviceRecovery(work.exec, view.owner, provisioning(), async () => {});
  const before = await work.exec.all("SELECT * FROM station_device_recovery");
  await expect(sealDeviceRecovery(work.exec, config, generation)).rejects.toThrow("owner changed");
  expect(await work.exec.all("SELECT * FROM station_device_recovery")).toEqual(before);
});
it("does not append an old job event when sealing races its authorized read", async () => {
  await initializeDeviceRecovery(work.exec, config);
  const job = await requireProductLabelJob(
    work.exec,
    work.input.credentialOwnership,
    work.input.jobId,
  );
  const exec = {
    all: work.exec.all,
    run: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO product_label_event_commands"))
        await sealDeviceRecovery(work.exec, config, generation);
      return work.exec.run(sql, params);
    },
  };
  await expect(
    appendProductLabelEvent(exec, work.input.credentialOwnership, {
      ...nextProductLabelEventBase(job, work.actor),
      kind: "sending",
    }),
  ).rejects.toThrow();
  expect(await work.exec.all("SELECT * FROM product_label_events")).toHaveLength(1);
});
it("does not acknowledge old events when sealing races receipt persistence", async () => {
  const { ackProductLabelEvents } = await import("../src/lib/product-labels/sync.js");
  const { PRODUCT_LABEL_PROTOCOL } = await import("@markiro/domain");
  await initializeDeviceRecovery(work.exec, config);
  const exec = {
    all: work.exec.all,
    run: async (sql: string, params?: unknown[]) => {
      if (sql.includes("INSERT INTO product_label_receipts"))
        await sealDeviceRecovery(work.exec, config, generation);
      return work.exec.run(sql, params);
    },
  };
  await ackProductLabelEvents(exec, work.input.credentialOwnership, [work.input.preparedEvent], {
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: [work.input.preparedEvent.eventId],
    quarantined: [],
  });
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
  expect(await work.exec.all("SELECT * FROM product_label_receipts")).toHaveLength(0);
});
it.each(["outbox", "scan_events_mirror", "boxes_mirror", "box_exceptions_mirror"])(
  "keeps foreign %s terminal evidence unresolved",
  async (table) => {
    if (table === "boxes_mirror")
      await work.exec.run(
        "INSERT INTO boxes_mirror(box_id,shift_id,terminal_id,opened_at) VALUES('foreign-box','shift','foreign','2026-09-11T00:00:00.000Z')",
      );
    else if (table === "box_exceptions_mirror")
      await work.exec.run(
        "INSERT INTO box_exceptions_mirror(kind,box_id,shift_id,terminal_id,reason,at) VALUES('reprint','box','shift','foreign','damaged','2026-09-11T00:00:00.000Z')",
      );
    else await work.exec.run(`UPDATE ${table} SET terminal_id='foreign'`);
    expect((await initializeDeviceRecovery(work.exec, config)).phase).toBe("owner_unresolved");
  },
);
it("reports saved conflicts, label quarantine and unknown printing separately from queued delivery", async () => {
  const { readSealedWorkSummary } = await import("../src/lib/credential-recovery.js");
  await initializeDeviceRecovery(work.exec, config);
  const job = await requireProductLabelJob(
    work.exec,
    work.input.credentialOwnership,
    work.input.jobId,
  );
  await appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
    ...nextProductLabelEventBase(job, work.actor),
    kind: "sending",
  });
  await work.exec.run(
    "INSERT INTO conflicts_mirror(code_hash,winning_scanned_at,detected_at) VALUES('conflict','2026-09-11T00:00:00.000Z','2026-09-11T00:00:00.000Z')",
  );
  expect(await readSealedWorkSummary(work.exec)).toMatchObject({
    conflicts: 1,
    quarantinedLabels: 0,
    unknownPrints: 1,
  });
});
it("refuses ordinary provisioning over unowned retained data before publishing roster or config", async () => {
  const { persistStationProvisioning } = await import("../src/lib/pairing.js");
  const writeConfig = vi.fn();
  await expect(
    persistStationProvisioning(provisioning(), {
      machineId: config.machineId,
      exec: work.exec,
      writeConfig,
    }),
  ).rejects.toThrow("Recovery identity required");
  expect(writeConfig).not.toHaveBeenCalled();
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
});
it("explicitly reprints saved bytes, verifies and retains an old job under the recovered key", async () => {
  const { prepareProductLabelReprint, sendPreparedProductLabel, verifyProductLabel } =
    await import("../src/lib/product-labels/printing.js");
  const { ackProductLabelEvents, readPendingProductLabelEvents } =
    await import("../src/lib/product-labels/sync.js");
  const { purgeCompletedProductLabelJobs } = await import("../src/lib/product-labels/retention.js");
  const { ackThrough } = await import("../src/lib/outbox.js");
  const { PRODUCT_LABEL_PROTOCOL } = await import("@markiro/domain");
  const view = await initializeDeviceRecovery(work.exec, config);
  if (!view.owner) throw new Error("missing owner");
  const old = await requireProductLabelJob(
    work.exec,
    work.input.credentialOwnership,
    work.input.jobId,
  );
  await appendProductLabelEvent(work.exec, work.input.credentialOwnership, {
    ...nextProductLabelEventBase(old, work.actor),
    kind: "sending",
  });
  await sealDeviceRecovery(work.exec, config, generation);
  await restoreDeviceRecovery(work.exec, view.owner, provisioning(), async () => {});
  const hash = await credentialGenerationOwnership(createCredentialGeneration("key-b"));
  if (!hash) throw new Error("missing hash");
  await restoreProductLabelWork(work.exec, hash, work.actor);
  expect(work.print).not.toHaveBeenCalled();
  const attemptId = await prepareProductLabelReprint(work.exec, {
    ...work.actor,
    credentialOwnership: hash,
    jobId: work.input.jobId,
    shiftId: work.input.shiftId,
    reason: "not_printed",
    recovery: true,
  });
  await sendPreparedProductLabel({ ...work.deps, credentialOwnership: hash }, work.input.jobId);
  expect(work.print.mock.calls[0]?.[1]).toEqual(
    Uint8Array.from(atob(work.input.bytesBase64), (byte) => byte.charCodeAt(0)),
  );
  await verifyProductLabel(work.exec, {
    ...work.actor,
    credentialOwnership: hash,
    jobId: work.input.jobId,
    attemptId,
    raw: work.input.raw,
  });
  expect(
    (await requireProductLabelJob(work.exec, hash, work.input.jobId)).credentialOwnership,
  ).toBe(work.input.credentialOwnership);
  expect(await purgeCompletedProductLabelJobs(work.exec, hash)).toBe(0);
  const events = (await readPendingProductLabelEvents(work.exec, hash, 100, null)).map(
    (row) => row.event,
  );
  await ackProductLabelEvents(work.exec, hash, events, {
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: events.map((event) => event.eventId),
    quarantined: [],
  });
  await ackThrough(work.exec, 1);
  await work.exec.run("UPDATE shift_mirror SET status='closed' WHERE id=?", [work.input.shiftId]);
  expect(await purgeCompletedProductLabelJobs(work.exec, hash)).toBe(1);
});
it("clears an explicitly rejected legacy key and roster without claiming its retained owner", async () => {
  const { sealUnresolvedDeviceRecovery } = await import("../src/lib/device-recovery.js");
  const { replaceOperatorsMirror, readOperatorsMirror } = await import("../src/lib/mirror.js");
  const unknown = {
    machineId: config.machineId,
    apiKey: "key-a",
    serverUrl: "https://api.example/api",
  };
  expect((await initializeDeviceRecovery(work.exec, unknown)).phase).toBe("owner_unresolved");
  await replaceOperatorsMirror(work.exec, [
    {
      operatorId: "op",
      name: "Operator",
      login: "1",
      role: "operator",
      pinHash: "verifier",
      badgeHash: null,
      active: true,
    },
  ]);
  const clearCredential = vi.fn(async () => {});
  await sealUnresolvedDeviceRecovery(work.exec, unknown, clearCredential);
  expect(clearCredential).toHaveBeenCalledOnce();
  expect(await readOperatorsMirror(work.exec)).toEqual([]);
  expect((await readDeviceRecovery(work.exec))?.owner).toBeNull();
  expect((await readDeviceRecovery(work.exec))?.phase).toBe("owner_unresolved");
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
});
it("resumes interrupted explicit legacy sealing and never clears a replacement key", async () => {
  const { sealUnresolvedDeviceRecovery } = await import("../src/lib/device-recovery.js");
  const unknown = {
    machineId: config.machineId,
    apiKey: "key-a",
    serverUrl: "https://api.example/api",
  };
  await initializeDeviceRecovery(work.exec, unknown);
  const clear = vi.fn(async () => {});
  await expect(
    sealUnresolvedDeviceRecovery(work.exec, { ...unknown, apiKey: "newer-key" }, clear),
  ).rejects.toThrow("credential changed");
  expect(clear).not.toHaveBeenCalled();
  await expect(
    sealUnresolvedDeviceRecovery(work.exec, unknown, async () => {
      throw new Error("interrupted config write");
    }),
  ).rejects.toThrow();
  work.restart();
  expect((await initializeDeviceRecovery(work.exec, unknown)).phase).toBe("sealed");
  expect((await initializeDeviceRecovery(work.exec, { machineId: config.machineId })).phase).toBe(
    "owner_unresolved",
  );
  expect(await work.exec.all("SELECT * FROM product_label_outbox")).toHaveLength(1);
});

it.each([false, true])(
  "blocks cross-hash reprint while another job is unresolved (inverse=%s)",
  async (inverse) => {
    const { recordProductLabelAcceptance } =
      await import("../src/lib/product-labels/acceptance.js");
    const { productLabelAcceptanceFixture } = await import("./support/product-labels.js");
    const { prepareProductLabelReprint, sendPreparedProductLabel, verifyProductLabel } =
      await import("../src/lib/product-labels/printing.js");
    const view = await initializeDeviceRecovery(work.exec, config);
    if (!view.owner) throw new Error("missing owner");
    async function finish(hash: string, input: typeof work.input) {
      await sendPreparedProductLabel({ ...work.deps, credentialOwnership: hash }, input.jobId);
      const job = await requireProductLabelJob(work.exec, hash, input.jobId);
      expect(
        await verifyProductLabel(work.exec, {
          ...work.actor,
          credentialOwnership: hash,
          jobId: input.jobId,
          attemptId: job.projection.attemptId,
          raw: input.raw,
        }),
      ).toBe("match");
    }
    await finish(work.input.credentialOwnership, work.input);
    await prepareProductLabelReprint(work.exec, {
      ...work.actor,
      credentialOwnership: work.input.credentialOwnership,
      jobId: work.input.jobId,
      shiftId: work.input.shiftId,
      reason: "damaged",
    });
    await finish(work.input.credentialOwnership, work.input);
    await sealDeviceRecovery(work.exec, config, generation);
    await restoreDeviceRecovery(work.exec, view.owner, provisioning(), async () => {});
    const hash = await credentialGenerationOwnership(createCredentialGeneration("key-b"));
    if (!hash) throw new Error("missing hash");
    const f = productLabelAcceptanceFixture({ serial: "SERIAL-43", ownership: hash });
    const second = {
      ...f,
      shiftId: work.input.shiftId,
      deviceId: work.input.deviceId,
      terminalId: work.input.deviceId,
      policy: work.input.policy,
      preparedEvent: {
        ...f.preparedEvent,
        shiftId: work.input.shiftId,
        policyRevision: work.input.policy.policyRevision,
        templateDigest: work.input.policy.snapshot.digest,
      },
    };
    expect(await recordProductLabelAcceptance(work.exec, second)).toMatchObject({
      status: "accepted",
    });
    if (inverse) {
      await finish(hash, second);
      await prepareProductLabelReprint(work.exec, {
        ...work.actor,
        credentialOwnership: hash,
        jobId: work.input.jobId,
        shiftId: work.input.shiftId,
        reason: "damaged",
      });
    }
    const before = await work.exec.all(
      "SELECT * FROM product_label_event_commands ORDER BY credential_ownership,event_id",
    );
    const target = inverse ? second : work.input;
    await expect(
      prepareProductLabelReprint(work.exec, {
        ...work.actor,
        credentialOwnership: hash,
        jobId: target.jobId,
        shiftId: target.shiftId,
        reason: "damaged",
      }),
    ).rejects.toMatchObject({ code: "PRODUCT_LABEL_BUSY" });
    expect(
      await work.exec.all(
        "SELECT * FROM product_label_event_commands ORDER BY credential_ownership,event_id",
      ),
    ).toEqual(before);
    expect(
      await work.exec.all("SELECT * FROM product_label_jobs WHERE status<>'completed'"),
    ).toHaveLength(1);
    // Replaying the already applied prepared command must bypass the busy guard,
    // even while another job is unresolved. Its stored bytes remain identical.
    await work.exec.run(
      `INSERT INTO product_label_event_commands
    (credential_ownership,event_id,job_id,command_token,event_digest,expected_sequence,expected_attempt_id,event_json,projection_json,recovery)
    SELECT credential_ownership,event_id,job_id,command_token,event_digest,expected_sequence,expected_attempt_id,event_json,projection_json,recovery
    FROM product_label_event_commands WHERE credential_ownership=? AND json_extract(event_json,'$.kind')='prepared'
    ON CONFLICT(credential_ownership,event_id) DO NOTHING`,
      [work.input.credentialOwnership],
    );
    expect(
      await work.exec.all(
        "SELECT * FROM product_label_event_commands ORDER BY credential_ownership,event_id",
      ),
    ).toEqual(before);
  },
);
