import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { applyMigrations } from "../src/lib/mirror";
import {
  createCredentialGeneration,
  credentialGenerationOwnership,
  sealCredentialGeneration,
} from "../src/lib/credential-recovery";
import type { StationClient } from "../src/lib/api-client";
import { createWarehouseWork } from "../src/lib/warehouse-reprint/work";
import {
  appendWarehouseEvent,
  finishWarehouseSession,
  prepareWarehouseJob,
  resumeWarehouseSession,
  saveWarehouseSession,
} from "../src/lib/warehouse-reprint/store";
import { makeRotatingExec, openFileDatabase } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "warehouse-finish-"));
  const path = join(dir, "station.sqlite");
  const databases = [openFileDatabase(path), openFileDatabase(path)];
  const exec = makeRotatingExec(databases);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  const generation = createCredentialGeneration("finish-test-owner");
  const resolvedOwner = await credentialGenerationOwnership(generation);
  if (!resolvedOwner) throw new Error("fixture owner");
  const owner: string = resolvedOwner;
  const options = {
    exec,
    client: {
      get: async () => {
        throw new TypeError("offline");
      },
    } as unknown as StationClient,
    generation,
    deviceId: input.deviceId,
    operatorId: input.operatorId,
    hardware: () => ({
      scanner: null,
      printer: input.printer.target,
      printerLanguage: "tspl" as const,
      printerDpi: 203 as const,
      verifyPrintedLabel: false,
    }),
    print: async () => {},
  };
  const work = createWarehouseWork(options);
  await work.initialize();
  const snapshot = work.getSnapshot().session;
  if (!snapshot) throw new Error("fixture session");
  const session = snapshot;
  async function job(
    state: "prepared" | "sending" | "sent" | "delivery_unknown" | "failed_before_send",
    sessionId = session?.sessionId,
  ) {
    if (!sessionId) throw new Error("fixture session");
    const value = {
      ...input,
      owner,
      sessionId,
      preparedEvent: { ...input.preparedEvent, sessionId },
    };
    await saveWarehouseSession(exec, { ...session, sessionId, status: "active" });
    await prepareWarehouseJob(exec, value);
    if (state !== "prepared") {
      const event = {
        eventId: crypto.randomUUID(),
        jobId: input.jobId,
        sessionId,
        attemptId: input.preparedEvent.attemptId,
        operatorId: input.operatorId,
        occurredAt: input.preparedEvent.occurredAt,
        sequence: 2,
      };
      if (state === "failed_before_send") {
        await appendWarehouseEvent(exec, owner, {
          ...event,
          kind: state,
          errorCode: "printer_unconfigured",
        });
      } else {
        await appendWarehouseEvent(exec, owner, { ...event, kind: "sending" });
        if (state === "sent")
          await appendWarehouseEvent(exec, owner, {
            ...event,
            eventId: crypto.randomUUID(),
            sequence: 3,
            kind: "sent",
          });
        if (state === "delivery_unknown")
          await appendWarehouseEvent(exec, owner, {
            ...event,
            eventId: crypto.randomUUID(),
            sequence: 3,
            kind: state,
            errorCode: "interrupted",
          });
      }
    }
    await work.poll();
    return value;
  }
  return {
    dir,
    path,
    databases,
    exec,
    input,
    owner,
    generation,
    options,
    work,
    session,
    job,
    async dispose() {
      await work.close();
      databases.forEach((db) => db.close());
      await rm(dir, { recursive: true, force: true });
    },
  };
}

it("finishes durably across pooled connections, duplicate calls, cleanup and process restart without deleting events", async () => {
  const f = await fixture();
  try {
    await f.job("sent");
    const events = await f.exec.all("SELECT * FROM warehouse_reprint_events ORDER BY sequence");
    const jobs = await f.exec.all("SELECT * FROM warehouse_reprint_jobs");
    const attempts = await f.exec.all("SELECT * FROM warehouse_reprint_attempts");
    const [first, duplicate] = await Promise.all([f.work.finish(), f.work.finish()]);
    expect([first, duplicate]).toEqual([true, true]);
    expect(f.work.getSnapshot().session).toBeNull();
    const closure = await f.exec.all("SELECT * FROM warehouse_reprint_session_closures");
    expect(
      await finishWarehouseSession(f.exec, f.owner, f.session.sessionId, f.input.operatorId),
    ).toBe(true);
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).toEqual(closure);

    await f.work.close();
    f.work.open();
    await f.work.start();
    expect(await resumeWarehouseSession(f.exec, f.owner)).toBeNull();
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_jobs")).toEqual(jobs);
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_attempts")).toEqual(attempts);
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_events ORDER BY sequence")).toEqual(
      events,
    );
    expect(
      await f.exec.all(
        "SELECT owner,session_id,operator_id FROM warehouse_reprint_session_closures",
      ),
    ).toEqual([
      { owner: f.owner, session_id: f.session.sessionId, operator_id: f.input.operatorId },
    ]);
    const restartDb = openFileDatabase(f.path);
    try {
      const restartExec = makeRotatingExec([restartDb, restartDb]);
      await applyMigrations(restartExec);
      const restarted = createWarehouseWork({ ...f.options, exec: restartExec });
      await restarted.initialize();
      expect(restarted.getSnapshot().session?.sessionId).not.toBe(f.session.sessionId);
      expect(restarted.getSnapshot().job).toBeNull();
      await restarted.close();
    } finally {
      restartDb.close();
    }
  } finally {
    await f.dispose();
  }
});

it.each(["prepared", "sending", "delivery_unknown", "failed_before_send"] as const)(
  "denies finishing with an owned %s job even when it belongs to a different session",
  async (state) => {
    const f = await fixture();
    try {
      await f.job(state, crypto.randomUUID());
      // A displayed successful/empty session must not hide another owned unresolved job.
      expect(await f.work.finish()).toBe(false);
      expect(f.work.getSnapshot().error).toBe("WAREHOUSE_RECOVERY_REQUIRED");
      expect(await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).toEqual([]);
      expect(await f.exec.all("SELECT state FROM warehouse_reprint_jobs")).toEqual([{ state }]);
    } finally {
      await f.dispose();
    }
  },
);

it("keeps ordinary pause/leave resumable", async () => {
  const f = await fixture();
  try {
    await f.work.close();
    const resumed = createWarehouseWork(f.options);
    await resumed.initialize();
    expect(resumed.getSnapshot().session?.sessionId).toBe(f.session.sessionId);
    expect(resumed.getSnapshot().session?.status).toBe("paused");
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).toEqual([]);
    await resumed.close();
  } finally {
    await f.dispose();
  }
});

it("does not reopen a finished session through stale saves or late preparation", async () => {
  const f = await fixture();
  try {
    expect(await f.work.finish()).toBe(true);
    await saveWarehouseSession(f.exec, { ...f.session, status: "active" });
    expect(await resumeWarehouseSession(f.exec, f.owner)).toBeNull();
    const value = {
      ...f.input,
      owner: f.owner,
      sessionId: f.session.sessionId,
      preparedEvent: { ...f.input.preparedEvent, sessionId: f.session.sessionId },
    };
    await expect(prepareWarehouseJob(f.exec, value)).rejects.toThrow("WAREHOUSE_SESSION_CLOSED");
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_events")).toEqual([]);
  } finally {
    await f.dispose();
  }
});

it("denies finish when credential generation is replaced during authorization", async () => {
  const f = await fixture();
  try {
    const originalAll = f.exec.all.bind(f.exec);
    let replace = true;
    f.exec.all = async <T>(sql: string, params?: unknown[]) => {
      const rows = await originalAll<T>(sql, params);
      if (replace && sql.includes("operators_mirror")) {
        replace = false;
        await sealCredentialGeneration(f.generation);
      }
      return rows;
    };
    expect(await f.work.finish()).toBe(false);
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).toEqual([]);
    expect((await resumeWarehouseSession(f.exec, f.owner))?.sessionId).toBe(f.session.sessionId);
  } finally {
    await f.dispose();
  }
});

it.each(["before", "after"] as const)(
  "survives interruption %s closure persistence",
  async (when) => {
    const f = await fixture();
    try {
      const run = f.exec.run.bind(f.exec);
      let interrupt = true;
      f.exec.run = async (sql, params) => {
        if (interrupt && sql.includes("INSERT INTO warehouse_reprint_session_closures")) {
          interrupt = false;
          if (when === "after") await run(sql, params);
          throw new Error("interrupted storage boundary");
        }
        await run(sql, params);
      };
      expect(await f.work.finish()).toBe(false);
      await f.work.close();
      const resumed = createWarehouseWork(f.options);
      await resumed.initialize();
      if (when === "before")
        expect(resumed.getSnapshot().session?.sessionId).toBe(f.session.sessionId);
      else expect(resumed.getSnapshot().session?.sessionId).not.toBe(f.session.sessionId);
      await resumed.close();
    } finally {
      await f.dispose();
    }
  },
);

it("rolls back a late reprint attempt in a finished session while preserving its pending events", async () => {
  const f = await fixture();
  try {
    const input = await f.job("sent");
    const events = await f.exec.all("SELECT * FROM warehouse_reprint_events ORDER BY sequence");
    expect(await f.work.finish()).toBe(true);
    await expect(
      appendWarehouseEvent(f.exec, f.owner, {
        kind: "reprint_prepared",
        eventId: crypto.randomUUID(),
        jobId: input.jobId,
        sessionId: input.sessionId,
        attemptId: crypto.randomUUID(),
        attemptNo: 2,
        operatorId: input.operatorId,
        sequence: 4,
        occurredAt: input.preparedEvent.occurredAt,
        reason: "lost",
      }),
    ).rejects.toThrow("WAREHOUSE_SESSION_CLOSED");
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_events ORDER BY sequence")).toEqual(
      events,
    );
    expect(await f.exec.all("SELECT attempt_no FROM warehouse_reprint_attempts")).toEqual([
      { attempt_no: 1 },
    ]);
    expect(await f.exec.all("SELECT state FROM warehouse_reprint_jobs")).toEqual([
      { state: "sent" },
    ]);
  } finally {
    await f.dispose();
  }
});

it("keeps finished sessions closed after same-device credential replacement and denies unrelated credentials", async () => {
  const f = await fixture();
  try {
    const { initializeDeviceRecovery, sealDeviceRecovery, restoreDeviceRecovery } =
      await import("../src/lib/device-recovery");
    const config = {
      machineId: "local",
      tenantId: "tenant",
      deviceId: f.input.deviceId,
      serverUrl: "https://api.example/api",
      apiKey: "finish-test-owner",
    };
    const recovery = await initializeDeviceRecovery(f.exec, config);
    if (!recovery.owner) throw new Error("fixture device");
    expect(await f.work.finish()).toBe(true);
    await sealDeviceRecovery(f.exec, config, f.generation);
    await restoreDeviceRecovery(
      f.exec,
      recovery.owner,
      {
        deviceId: f.input.deviceId,
        tenantId: "tenant",
        serverUrl: config.serverUrl,
        apiKey: "replacement-test-key",
        deviceName: "Station",
        organizationName: "Org",
        operators: [],
      },
      async () => {},
    );
    await seedWarehouseOperator(f.exec, f.input.operatorId);
    const replacement = createCredentialGeneration("replacement-test-key");
    const nextOwner = await credentialGenerationOwnership(replacement);
    if (!nextOwner) throw new Error("replacement owner");
    expect(await resumeWarehouseSession(f.exec, nextOwner)).toBeNull();
    expect(await resumeWarehouseSession(f.exec, f.owner)).toBeNull();
    const resumed = createWarehouseWork({ ...f.options, generation: replacement });
    await resumed.initialize();
    expect(resumed.getSnapshot().session?.sessionId).not.toBe(f.session.sessionId);
    expect(resumed.getSnapshot().session?.owner).toBe(nextOwner);
    expect(
      await f.exec.all("SELECT owner,session_id FROM warehouse_reprint_session_closures"),
    ).toEqual([{ owner: f.owner, session_id: f.session.sessionId }]);
    await resumed.close();
  } finally {
    await f.dispose();
  }
});

it("drains an in-flight print before durable finish and admits no extra scan during the drain", async () => {
  const f = await fixture();
  try {
    await f.job("prepared");
    let dispatched: () => void = () => {};
    let settle: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const printed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    f.options.print = async () => {
      dispatched();
      await printed;
    };
    const printing = f.work.sendPrepared();
    await started;
    const finishing = f.work.finish();
    const scan = f.work.scan("invalid new scan");
    expect(await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).toEqual([]);
    settle();
    await Promise.all([printing, scan]);
    expect(await finishing).toBe(true);
    expect(await f.exec.all("SELECT state FROM warehouse_reprint_jobs")).toEqual([
      { state: "sent" },
    ]);
    expect(
      await f.exec.all(
        "SELECT sequence,receive_status FROM warehouse_reprint_events ORDER BY sequence",
      ),
    ).toEqual([
      { sequence: 1, receive_status: "pending" },
      { sequence: 2, receive_status: "pending" },
      { sequence: 3, receive_status: "pending" },
    ]);
  } finally {
    await f.dispose();
  }
});

it.each([true, false])(
  "scopes unresolved-job finish denial to associated credential owners (associated=%s)",
  async (associated) => {
    const f = await fixture();
    try {
      const durableOwner = JSON.stringify({
        serverOrigin: "https://api.example",
        tenantId: "tenant",
        deviceId: f.input.deviceId,
        kind: "station",
      });
      await f.exec.run(
        "INSERT INTO station_device_recovery(id,machine_id,owner_json,phase,active_hash) VALUES(1,'machine',?,'active',?)",
        [durableOwner, f.owner],
      );
      if (associated)
        await f.exec.run(
          "INSERT INTO station_device_owners(credential_hash,owner_json) VALUES('retained-owner',?)",
          [durableOwner],
        );
      const sessionId = crypto.randomUUID();
      await saveWarehouseSession(f.exec, {
        ...f.session,
        owner: "retained-owner",
        sessionId,
        status: "active",
      });
      await prepareWarehouseJob(f.exec, {
        ...f.input,
        owner: "retained-owner",
        sessionId,
        preparedEvent: { ...f.input.preparedEvent, sessionId },
      });
      expect(await f.work.finish()).toBe(!associated);
      expect(await f.exec.all("SELECT owner,state FROM warehouse_reprint_jobs")).toEqual([
        { owner: "retained-owner", state: "prepared" },
      ]);
      expect((await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).length).toBe(
        associated ? 0 : 1,
      );
    } finally {
      await f.dispose();
    }
  },
);

it.each(["accepted", "pending", "quarantined"] as const)(
  "preserves the retention horizon and %s events after finishing",
  async (receipt) => {
    const f = await fixture();
    try {
      const { purgeWarehouseJobs } = await import("../src/lib/warehouse-reprint/retention");
      await f.job("sent");
      await f.exec.run("UPDATE warehouse_reprint_events SET receive_status=?", [receipt]);
      expect(await f.work.finish()).toBe(true);
      expect(
        await f.exec.all(
          "SELECT status,json_extract(session_json,'$.status') AS json_status FROM warehouse_reprint_sessions WHERE session_id=?",
          [f.session.sessionId],
        ),
      ).toEqual([{ status: "paused", json_status: "paused" }]);
      const next = createWarehouseWork(f.options);
      await next.initialize();
      await purgeWarehouseJobs(f.exec, f.owner, "2000-01-01T00:00:00Z");
      expect((await f.exec.all("SELECT * FROM warehouse_reprint_jobs")).length).toBe(1);
      await purgeWarehouseJobs(f.exec, f.owner, "9999-12-31T00:00:00Z");
      expect((await f.exec.all("SELECT * FROM warehouse_reprint_jobs")).length).toBe(
        receipt === "accepted" ? 0 : 1,
      );
      expect((await f.exec.all("SELECT * FROM warehouse_reprint_events")).length).toBe(
        receipt === "accepted" ? 0 : 3,
      );
      expect((await f.exec.all("SELECT * FROM warehouse_reprint_session_closures")).length).toBe(1);
      await next.close();
    } finally {
      await f.dispose();
    }
  },
);
