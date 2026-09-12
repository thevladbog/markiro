// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PRODUCT_LABEL_PROTOCOL,
  type ProductLabelEvent,
  type ProductLabelReceipt,
} from "@markiro/domain";
import {
  ackProductLabelEvents,
  readPendingProductLabelEvents,
  productLabelSetSignature,
} from "../src/lib/product-labels/sync.js";
import {
  sendPreparedProductLabel,
  verifyProductLabel,
} from "../src/lib/product-labels/printing.js";
import { readProductLabelJob } from "../src/lib/product-labels/store.js";
import { createSyncEngine, BACKOFF_START_MS, type SyncEngine } from "../src/lib/sync.js";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  sealCredentialGeneration,
  readSealedWorkSummary,
  clearRejectedCredentialState,
} from "../src/lib/credential-recovery.js";
import { openProductLabelWork } from "./support/product-label-work.js";

import {
  initializeDeviceRecovery,
  sealDeviceRecovery,
  restoreDeviceRecovery,
} from "../src/lib/device-recovery.js";

describe("product label sync", () => {
  let work: Awaited<ReturnType<typeof openProductLabelWork>>;
  let generation: ReturnType<typeof createCredentialGeneration>;
  const engines: SyncEngine[] = [];
  beforeEach(async () => {
    generation = createCredentialGeneration("test-station-key");
    const ownership = await credentialGenerationOwnership(generation);
    if (!ownership) throw new Error("missing fixture ownership");
    work = await openProductLabelWork("required", ownership, true, true);
  });
  afterEach(() => {
    for (const engine of engines.splice(0)) engine.stop();
    work?.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const pending = () =>
    readPendingProductLabelEvents(work.exec, work.input.credentialOwnership, 100, null);
  const receipt = (events: ProductLabelEvent[]): ProductLabelReceipt => ({
    protocol: PRODUCT_LABEL_PROTOCOL,
    acceptedEventIds: events.map((event) => event.eventId),
    quarantined: [],
  });
  const verify = () =>
    verifyProductLabel(work.exec, {
      ...work.actor,
      jobId: work.input.jobId,
      attemptId: work.input.preparedEvent.attemptId,
      credentialOwnership: work.input.credentialOwnership,
      raw: work.input.raw,
    });
  function engine(
    post: ReturnType<typeof client>,
    extra: Partial<Parameters<typeof createSyncEngine>[0]> = {},
  ) {
    const value = createSyncEngine({
      exec: work.exec,
      client: { post: vi.fn().mockImplementation(post) },
      machineId: "station-local",
      credentialGeneration: generation,
      onState: () => {},
      ...extra,
    });
    engines.push(value);
    return value;
  }
  interface SentBatch {
    batchId: string;
    productLabelEvents?: ProductLabelEvent[];
    items: unknown[];
  }
  function client(action: (body: SentBatch) => unknown | Promise<unknown>) {
    return vi.fn(async (path: string, body: SentBatch) =>
      path === "/station/scans"
        ? action(body)
        : path === "/station/codes/releases"
          ? { until: "0", releasedCodeHashes: [] }
          : { reviewedCodeHashes: [] },
    );
  }
  const response = (body: SentBatch) => ({
    applied: body.items.length,
    alreadyApplied: false,
    conflicts: [],
    productLabelReceipt: receipt(body.productLabelEvents ?? []),
    validationOccurrences: [
      {
        shiftId: work.input.shiftId,
        codeHash: work.input.codeHash,
        scannedAt: work.input.acceptedAt,
        outcome: "first_accepted",
      },
    ],
  });

  it("restores an exact pinned key-A batch under verified same-device key B without changing evidence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const config = {
      machineId: "station-local",
      deviceId: work.input.deviceId,
      tenantId: "tenant-a",
      serverUrl: "https://station.example/api",
      apiKey: "test-station-key",
    };
    const view = await initializeDeviceRecovery(work.exec, config);
    expect(view.owner).not.toBeNull();
    await work.exec.run(
      `INSERT INTO boxes_mirror(box_id,shift_id,terminal_id,sscc,opened_at,closed_at,closed_by) VALUES('retained-box',?,?,'004601234560000017',?,?,NULL)`,
      [work.input.shiftId, work.input.terminalId, work.input.acceptedAt, work.input.acceptedAt],
    );
    await work.exec.run(
      `INSERT INTO box_exceptions_mirror(kind,box_id,shift_id,terminal_id,reason,at) VALUES('reprint','retained-box',?,?,'damaged',?)`,
      [work.input.shiftId, work.input.terminalId, work.input.acceptedAt],
    );
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    const events = await work.exec.all("SELECT * FROM product_label_events");
    const jobs = await work.exec.all("SELECT * FROM product_label_accept_commands");
    const requests: SentBatch[] = [];
    const first = engine(
      client((body) => {
        requests.push(structuredClone(body));
        throw new Error("lost reply");
      }),
    );
    first.nudge();
    await first.idle();
    first.stop();
    const pin = await work.exec.all(
      "SELECT * FROM station_meta WHERE key='sync_pending_product_label_batch'",
    );
    await sealDeviceRecovery(work.exec, config, generation);
    work.restart();
    const sealed = await initializeDeviceRecovery(work.exec, {
      machineId: config.machineId,
      deviceId: config.deviceId,
      serverUrl: config.serverUrl,
    });
    expect(sealed.phase).toBe("sealed");
    if (!sealed.owner) throw new Error("missing owner");
    const provisioning = {
      deviceId: config.deviceId,
      tenantId: config.tenantId,
      serverUrl: config.serverUrl,
      apiKey: "key-b",
      deviceName: "Station",
      organizationName: "Org",
      operators: [],
    };
    await expect(
      restoreDeviceRecovery(
        work.exec,
        sealed.owner,
        { ...provisioning, tenantId: "foreign" },
        async () => {},
      ),
    ).rejects.toThrow();
    const foreign = engine(client(response), {
      credentialGeneration: createCredentialGeneration("foreign"),
    });
    foreign.nudge();
    await foreign.idle();
    foreign.stop();
    expect(
      await work.exec.all(
        "SELECT * FROM station_meta WHERE key='sync_pending_product_label_batch'",
      ),
    ).toEqual(pin);
    await restoreDeviceRecovery(work.exec, sealed.owner, provisioning, async () => {});
    const second = engine(
      client((body) => {
        requests.push(structuredClone(body));
        return response(body);
      }),
      { credentialGeneration: createCredentialGeneration("key-b") },
    );
    second.nudge();
    await second.idle();
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]).toMatchObject({
      items: [],
      exceptions: [expect.objectContaining({ kind: "reprint", boxId: "retained-box" })],
    });
    expect(requests[2]?.productLabelEvents).toBeUndefined();
    expect(await work.exec.all("SELECT * FROM boxes_mirror WHERE acked_at IS NULL")).toEqual([]);
    expect(await work.exec.all("SELECT * FROM box_exceptions_mirror")).toEqual([]);
    expect(await readPendingProductLabelEvents(work.exec, "foreign", 100, null)).toEqual([]);
    await expect(
      ackProductLabelEvents(
        work.exec,
        "foreign",
        requests[0]?.productLabelEvents ?? [],
        receipt(requests[0]?.productLabelEvents ?? []),
      ),
    ).rejects.toThrow();
    expect(await work.exec.all("SELECT * FROM product_label_outbox")).toEqual([]);
    expect(await work.exec.all("SELECT * FROM outbox")).toEqual([]);
    expect(await work.exec.all("SELECT * FROM product_label_events")).toEqual(events);
    expect(await work.exec.all("SELECT * FROM product_label_accept_commands")).toEqual(jobs);
    expect(work.print).toHaveBeenCalledTimes(1);
  });

  it("fences a delayed close ACK after sealing and restores that exact close with key B", async () => {
    const config = {
      machineId: "station-local",
      deviceId: work.input.deviceId,
      tenantId: "tenant-a",
      serverUrl: "https://station.example",
      apiKey: "test-station-key",
    };
    const view = await initializeDeviceRecovery(work.exec, config);
    if (!view.owner) throw new Error("missing owner");
    await work.exec.run(
      `INSERT INTO shift_close_outbox(event_id,shift_id,device_id,product_id,product_name,actual_qty,closed_box_count,closed_at) VALUES('close-event','another-shift',?,'product','Product',0,0,'2026-09-11T00:00:00.000Z')`,
      [work.input.deviceId],
    );
    const closures: unknown[] = [];
    let resolve!: (value: unknown) => void;
    const post = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/station/shift-closures") {
        closures.push(body);
        return new Promise((done) => {
          resolve = done;
        });
      }
      return { applied: 0, alreadyApplied: false, conflicts: [] };
    });
    const sync = engine(post);
    sync.nudge();
    await vi.waitFor(() => expect(closures).toHaveLength(1));
    await sealDeviceRecovery(work.exec, config, generation);
    resolve({ outcome: "accepted" });
    await sync.idle();
    sync.stop();
    expect(
      await work.exec.all("SELECT * FROM shift_close_outbox WHERE state='pending'"),
    ).toHaveLength(1);
    await restoreDeviceRecovery(
      work.exec,
      view.owner,
      {
        deviceId: config.deviceId,
        tenantId: config.tenantId,
        serverUrl: config.serverUrl,
        apiKey: "key-b",
        deviceName: "Station",
        organizationName: "Org",
        operators: [],
      },
      async () => {},
    );
    const replay = engine(
      vi.fn(async (path: string, body: SentBatch) => {
        if (path === "/station/shift-closures") {
          closures.push(body);
          return { outcome: "accepted" };
        }
        if (path === "/station/scans") return response(body);
        return { until: "0", releasedCodeHashes: [], reviewedCodeHashes: [] };
      }),
      { credentialGeneration: createCredentialGeneration("key-b") },
    );
    replay.nudge();
    await replay.idle();
    expect(closures).toHaveLength(2);
    expect(closures[1]).toEqual(closures[0]);
    expect(
      await work.exec.all("SELECT * FROM shift_close_outbox WHERE state='pending'"),
    ).toHaveLength(0);
  });

  it("keeps immutable events after ACK and does not remove a later verification", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    const sent = (await pending()).map((row) => row.event);
    expect(sent).toHaveLength(3);
    await verify();
    await ackProductLabelEvents(work.exec, work.input.credentialOwnership, sent, receipt(sent));
    expect((await pending()).map((row) => row.event.kind)).toEqual(["verified"]);
    expect(await work.exec.all("SELECT * FROM product_label_events")).toHaveLength(4);
    expect(await work.exec.all("SELECT * FROM product_label_receipts")).toHaveLength(3);
    expect(productLabelSetSignature(sent)).toBe(productLabelSetSignature(structuredClone(sent)));
    expect(productLabelSetSignature(sent)).not.toBe(productLabelSetSignature(sent.slice(1)));
  });

  it.each(["missing", "foreign", "duplicate", "overlap"])(
    "rejects a %s receipt before deleting any queued facts",
    async (kind) => {
      const sent = (await pending()).map((row) => row.event);
      const bad = receipt(sent);
      if (kind === "missing") bad.acceptedEventIds = [];
      if (kind === "foreign") bad.acceptedEventIds = [crypto.randomUUID()];
      if (kind === "duplicate") bad.acceptedEventIds.push(sent[0]!.eventId);
      if (kind === "overlap")
        bad.quarantined = [{ eventId: sent[0]!.eventId, code: "ownership_conflict" }];
      await expect(
        ackProductLabelEvents(work.exec, work.input.credentialOwnership, sent, bad),
      ).rejects.toThrow();
      expect(await pending()).toHaveLength(1);
      expect(await work.exec.all("SELECT * FROM product_label_receipts")).toHaveLength(0);
    },
  );

  it("atomically records quarantine and ownership conflict before dropping the delivery row", async () => {
    const sent = (await pending()).map((row) => row.event);
    const verdict: ProductLabelReceipt = {
      protocol: PRODUCT_LABEL_PROTOCOL,
      acceptedEventIds: [],
      quarantined: [{ eventId: work.input.preparedEvent.eventId, code: "ownership_conflict" }],
    };
    await work.exec.run(
      "CREATE TRIGGER ack_fault BEFORE DELETE ON product_label_outbox BEGIN SELECT RAISE(ABORT,'ack fault'); END",
    );
    await expect(
      ackProductLabelEvents(work.exec, work.input.credentialOwnership, sent, verdict),
    ).rejects.toThrow("ack fault");
    expect(await pending()).toHaveLength(1);
    expect(
      (await readProductLabelJob(work.exec, work.input.credentialOwnership, work.input.jobId))
        ?.ownershipConflict,
    ).toBe(false);
    expect(await work.exec.all("SELECT * FROM product_label_receipts")).toHaveLength(0);
    await work.exec.run("DROP TRIGGER ack_fault");
    await ackProductLabelEvents(work.exec, work.input.credentialOwnership, sent, verdict);
    expect(await pending()).toHaveLength(0);
    expect(
      (await readProductLabelJob(work.exec, work.input.credentialOwnership, work.input.jobId))
        ?.ownershipConflict,
    ).toBe(true);
    expect(
      await work.exec.all("SELECT outcome,rejection_code FROM product_label_receipts"),
    ).toEqual([{ outcome: "quarantined", rejection_code: "ownership_conflict" }]);
  });

  it("keeps the exact failed batch after a later verification, then delivers that new event separately", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    const requests: SentBatch[] = [];
    const post = client(async (body) => {
      requests.push(structuredClone(body));
      if (requests.length === 1) throw new Error("lost reply");
      return response(body);
    });
    const sync = engine(post);
    sync.nudge();
    await sync.idle();
    await verify();
    await vi.advanceTimersByTimeAsync(BACKOFF_START_MS + 1);
    await sync.idle();
    expect(requests).toHaveLength(3);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.productLabelEvents?.map((event) => event.kind)).toEqual(["verified"]);
    expect(requests[2]?.batchId).not.toBe(requests[1]?.batchId);
    expect(await pending()).toHaveLength(0);
    expect(work.print).toHaveBeenCalledTimes(1);
    expect(await work.exec.all("SELECT outcome FROM validation_occurrences")).toEqual([
      { outcome: "first_accepted" },
    ]);
  });

  it("retries the pinned batch if durable occurrence confirmation fails before acknowledgement", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await work.exec.run(
      "CREATE TRIGGER occurrence_ack_fault BEFORE UPDATE ON validation_occurrences BEGIN SELECT RAISE(ABORT,'RECEIPT_DISK_FAILURE'); END;",
    );
    const requests: SentBatch[] = [];
    const post = client((body) => {
      requests.push(structuredClone(body));
      return response(body);
    });
    const sync = engine(post);
    sync.nudge();
    await sync.idle();
    sync.stop();
    expect(await work.exec.all("SELECT * FROM outbox")).toHaveLength(1);
    expect(await pending()).toHaveLength(1);
    await work.exec.run("DROP TRIGGER occurrence_ack_fault");
    work.restart();
    const resumed = engine(post);
    resumed.nudge();
    await resumed.idle();
    expect(requests[1]).toEqual(requests[0]);
    expect(await work.exec.all("SELECT outcome FROM validation_occurrences")).toEqual([
      { outcome: "first_accepted" },
    ]);
    expect(await work.exec.all("SELECT * FROM outbox")).toHaveLength(0);
  });

  it("does not ACK scans or labels when the API omits the explicit label receipt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sync = engine(
      client((body) => ({ applied: body.items.length, alreadyApplied: true, conflicts: [] })),
    );
    sync.nudge();
    await sync.idle();
    expect(await pending()).toHaveLength(1);
    expect(await work.exec.all("SELECT * FROM outbox")).toHaveLength(1);
    expect(
      await work.exec.all("SELECT * FROM station_meta WHERE key='sync_pending_batch_id'"),
    ).toHaveLength(1);
  });

  it("replays the exact request after a partial ACK and process restart", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    const requests: SentBatch[] = [];
    const post = client((body) => {
      requests.push(structuredClone(body));
      return response(body);
    });
    await work.exec.run(
      "CREATE TRIGGER ack_fault BEFORE DELETE ON product_label_outbox BEGIN SELECT RAISE(ABORT,'ack fault'); END",
    );
    const first = engine(post);
    first.nudge();
    await first.idle();
    first.stop();
    expect(await work.exec.all("SELECT * FROM outbox")).toHaveLength(0);
    await verify();
    work.restart();
    await work.exec.run("DROP TRIGGER ack_fault");
    const second = engine(post, {
      credentialGeneration: createCredentialGeneration("test-station-key"),
    });
    second.nudge();
    await second.idle();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.productLabelEvents?.map((event) => event.kind)).toEqual(["verified"]);
    expect(await pending()).toHaveLength(0);
  });

  it("a sealed or unbound credential cannot ACK the pending labels", async () => {
    const sync = engine(
      client(async (body) => {
        await sealCredentialGeneration(generation);
        return response(body);
      }),
    );
    sync.nudge();
    await sync.idle();
    expect(await pending()).toHaveLength(1);
    const unbound = engine(client(response), {
      credentialGeneration: createCredentialGeneration(),
    });
    unbound.nudge();
    await unbound.idle();
    expect(await pending()).toHaveLength(1);
  });

  it("includes pending labels in recovery counts and preserves them while clearing reproducible caches", async () => {
    expect(await readSealedWorkSummary(work.exec)).toMatchObject({ productLabels: 1, total: 2 });
    await clearRejectedCredentialState({
      exec: work.exec,
      clearCredential: async () => {},
      credentialGeneration: generation,
    });
    expect(await pending()).toHaveLength(1);
    expect(
      await readProductLabelJob(work.exec, work.input.credentialOwnership, work.input.jobId),
    ).not.toBeNull();
  });

  it("does not send dependent label events ahead of their parent scan's batch", async () => {
    await work.exec.run("UPDATE outbox SET id=101 WHERE id=1");
    for (let id = 1; id <= 100; id++)
      await work.exec.run(
        "INSERT INTO outbox(id,shift_id,terminal_id,raw,verdict,scanned_at) VALUES(?,?,?,?,?,?)",
        [
          id,
          work.input.shiftId,
          work.input.terminalId,
          "invalid-scan",
          "invalid",
          work.input.acceptedAt,
        ],
      );
    const requests: SentBatch[] = [];
    const sync = engine(
      client((body) => {
        requests.push(structuredClone(body));
        return response(body);
      }),
    );
    sync.nudge();
    await sync.idle();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.items).toHaveLength(100);
    expect(requests[0]?.productLabelEvents).toBeUndefined();
    expect(requests[1]?.items).toHaveLength(1);
    expect(requests[1]?.productLabelEvents).toEqual([work.input.preparedEvent]);
  });

  it("preserves an explicitly empty label channel for a pre-feature pinned batch", async () => {
    for (const [key, value] of [
      ["sync_pending_batch_id", "legacy:fixed:1"],
      ["sync_pending_ceiling", "1"],
      ["sync_pending_box_ceiling", "0"],
      ["sync_pending_exception_ceiling", "0"],
    ])
      await work.exec.run("INSERT INTO station_meta(key,value) VALUES(?,?)", [key, value]);
    const requests: SentBatch[] = [];
    const sync = engine(
      client((body) => {
        requests.push(structuredClone(body));
        return response(body);
      }),
    );
    sync.nudge();
    await sync.idle();
    expect(requests[0]?.batchId).toBe("legacy:fixed:1");
    expect(requests[0]?.productLabelEvents).toBeUndefined();
    expect(requests[1]?.productLabelEvents).toEqual([work.input.preparedEvent]);
    expect(requests[1]?.items).toHaveLength(0);
  });

  it("quarantines a malformed local event without discarding other immutable facts", async () => {
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    await work.exec.run(
      "UPDATE product_label_events SET event_json=json_set(event_json,'$.kind','corrupted') WHERE sequence=1",
    );
    expect((await pending()).map((row) => row.event.kind)).toEqual(["sending", "sent"]);
    expect(
      await work.exec.all("SELECT outcome,rejection_code FROM product_label_receipts"),
    ).toEqual([{ outcome: "quarantined", rejection_code: "storage_invalid" }]);
    expect(await work.exec.all("SELECT * FROM product_label_events")).toHaveLength(3);
  });

  it("does not read or acknowledge another credential owner's events", async () => {
    const sent = (await pending()).map((row) => row.event);
    expect(await readPendingProductLabelEvents(work.exec, "other-owner", 100, null)).toEqual([]);
    await expect(
      ackProductLabelEvents(work.exec, "other-owner", sent, receipt(sent)),
    ).rejects.toThrow();
    expect(await pending()).toHaveLength(1);
  });

  it("does not start a request before the exact request envelope is saved", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await work.exec.run(
      "CREATE TRIGGER pin_fault BEFORE INSERT ON station_meta WHEN NEW.key='sync_pending_product_label_batch' BEGIN SELECT RAISE(ABORT,'pin fault'); END",
    );
    const post = client(response);
    const sync = engine(post);
    sync.nudge();
    await sync.idle();
    expect(post).not.toHaveBeenCalled();
    expect(await pending()).toHaveLength(1);
    expect(await work.exec.all("SELECT * FROM outbox")).toHaveLength(1);
  });

  it("replays a completely acknowledged request if clearing its pinned identity fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await sendPreparedProductLabel(work.deps, work.input.jobId);
    await work.exec.run(
      "CREATE TRIGGER retire_fault BEFORE DELETE ON station_meta WHEN OLD.key='sync_pending_product_label_batch' BEGIN SELECT RAISE(ABORT,'retire fault'); END",
    );
    const requests: SentBatch[] = [];
    const post = client((body) => {
      requests.push(structuredClone(body));
      return response(body);
    });
    const first = engine(post);
    first.nudge();
    await first.idle();
    first.stop();
    expect(await pending()).toHaveLength(0);
    await verify();
    work.restart();
    await work.exec.run("DROP TRIGGER retire_fault");
    const second = engine(post);
    second.nudge();
    await second.idle();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2]?.productLabelEvents?.map((event) => event.kind)).toEqual(["verified"]);
    expect(await pending()).toHaveLength(0);
  });
});
