import type { PrintTarget } from "../src/lib/hardware";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { applyMigrations, type SqlExecutor } from "../src/lib/mirror";
import { makeRotatingExec } from "./support/sqlite-exec";
import { warehousePreparedJobInput, seedWarehouseOperator } from "./support/warehouse-reprint";
import {
  saveWarehouseSession,
  prepareWarehouseJob,
  readWarehouseJob,
  appendWarehouseEvent,
} from "../src/lib/warehouse-reprint/store";
import {
  printWarehouseJob,
  recoverWarehouseJobs,
  verifyWarehouseJob,
  reprintWarehouseJob,
} from "../src/lib/warehouse-reprint/printing";
it("keeps one send, rejects !1 verification and explicitly replays frozen bytes", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, input.operatorId);
  try {
    await saveWarehouseSession(exec, {
      owner: input.owner,
      sessionId: input.sessionId,
      operatorId: input.operatorId,
      reason: input.reason,
      status: "active",
      unitTemplate: null,
      boxTemplate: input.template,
    });
    await prepareWarehouseJob(exec, input);
    const transport = vi.fn(async (_target: PrintTarget, _bytes: Uint8Array): Promise<void> => {
      expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
        "sending",
      );
      throw new Error("lost response");
    });
    const deps = {
      exec,
      owner: input.owner,
      operatorId: input.operatorId,
      profile: input.printer,
      print: transport,
      isCurrent: () => true,
    };
    await Promise.all([printWarehouseJob(deps, input.jobId), printWarehouseJob(deps, input.jobId)]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "delivery_unknown",
    );
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(
      await verifyWarehouseJob(
        exec,
        input.owner,
        input.jobId,
        input.operatorId,
        `!100${input.source.identity}`,
      ),
    ).toBe(false);
    expect(
      await verifyWarehouseJob(
        exec,
        input.owner,
        input.jobId,
        input.operatorId,
        `00${input.source.identity}`,
      ),
    ).toBe(true);
    transport.mockImplementation(async (_target, bytes) => {
      expect(btoa(String.fromCharCode(...bytes))).toBe(input.bytesBase64);
    });
    await reprintWarehouseJob(deps, input.jobId, "lost");
    expect(transport).toHaveBeenCalledTimes(2);
  } finally {
    db.close();
  }
});
it("requires an explicit recovery before changing the frozen endpoint", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const i = warehousePreparedJobInput();
  await seedWarehouseOperator(exec, i.operatorId);
  try {
    await saveWarehouseSession(exec, {
      owner: i.owner,
      sessionId: i.sessionId,
      operatorId: i.operatorId,
      reason: i.reason,
      status: "active",
      unitTemplate: null,
      boxTemplate: i.template,
    });
    await prepareWarehouseJob(exec, i);
    const print = vi.fn().mockResolvedValue(undefined);
    const profile = {
      ...i.printer,
      id: "new",
      name: "Replacement",
      target: { kind: "tcp" as const, host: "127.0.0.2", port: 9100 },
    };
    const deps = {
      exec,
      owner: i.owner,
      operatorId: i.operatorId,
      profile,
      print,
      isCurrent: () => true,
    };
    await printWarehouseJob(deps, i.jobId);
    expect(print).not.toHaveBeenCalled();
    expect((await readWarehouseJob(exec, i.owner, i.jobId)).projection.state).toBe(
      "failed_before_send",
    );
    await reprintWarehouseJob(deps, i.jobId, "not_printed");
    expect(print).toHaveBeenCalledWith(profile.target, expect.any(Uint8Array));
    expect((await readWarehouseJob(exec, i.owner, i.jobId)).printer).toEqual(profile);
  } finally {
    db.close();
  }
});

function deferred() {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function prepare(exec: SqlExecutor, owner = "owner") {
  const input = { ...warehousePreparedJobInput(), owner };
  await seedWarehouseOperator(exec, input.operatorId);
  await saveWarehouseSession(exec, {
    owner: input.owner,
    sessionId: input.sessionId,
    operatorId: input.operatorId,
    reason: input.reason,
    status: "active",
    unitTemplate: null,
    boxTemplate: input.template,
  });
  await prepareWarehouseJob(exec, input);
  return input;
}
it("waits for a live transport outcome before a second controller recovers its sending claim", async () => {
  const db = new DatabaseSync(":memory:");
  const raw = makeRotatingExec([db, db]);
  const outcomeStarted = deferred();
  const outcomeRelease = deferred();
  const exec: SqlExecutor = {
    all: raw.all,
    run: async (sql, params) => {
      if (
        sql.startsWith("INSERT INTO warehouse_reprint_commands") &&
        typeof params?.[3] === "string" &&
        JSON.parse(params[3]).event?.kind === "sent"
      ) {
        outcomeStarted.resolve();
        await outcomeRelease.promise;
      }
      await raw.run(sql, params);
    },
  };
  await applyMigrations(exec);
  const input = await prepare(exec);
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  const send = printWarehouseJob(
    {
      exec,
      owner: input.owner,
      operatorId: input.operatorId,
      profile: input.printer,
      isCurrent: () => true,
      print: async () => {
        calls += 1;
        entered.resolve();
        await release.promise;
      },
    },
    input.jobId,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  let recovered = false;
  const recovery = recoverWarehouseJobs(exec, input.owner, input.operatorId).then(() => {
    recovered = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(recovered).toBe(false);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "sending",
    );
    release.resolve();
    await outcomeStarted.promise;
    expect(recovered).toBe(false);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "sending",
    );
    outcomeRelease.resolve();
    expect(await send).toBeNull();
    await recovery;
    expect(calls).toBe(1);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe("sent");
    expect(
      await exec.all(
        "SELECT json_extract(event_json,'$.kind') AS kind FROM warehouse_reprint_events ORDER BY sequence",
      ),
    ).toEqual([{ kind: "prepared" }, { kind: "sending" }, { kind: "sent" }]);
  } finally {
    release.resolve();
    outcomeRelease.resolve();
    await send;
    await recovery;
    db.close();
  }
});
it("records a durable owner change after claiming but before transport as known unsent", async () => {
  const db = new DatabaseSync(":memory:");
  let current = true;
  const exec = makeRotatingExec([db, db], {
    afterRun: (sql, params) => {
      if (
        sql.startsWith("INSERT INTO warehouse_reprint_commands") &&
        typeof params[3] === "string" &&
        JSON.parse(params[3]).event?.kind === "sending"
      )
        current = false;
    },
  });
  await applyMigrations(exec);
  const input = await prepare(exec);
  let calls = 0;
  try {
    await printWarehouseJob(
      {
        exec,
        owner: input.owner,
        operatorId: input.operatorId,
        profile: input.printer,
        isCurrent: () => current,
        print: async () => {
          calls += 1;
        },
      },
      input.jobId,
    );
    expect(calls).toBe(0);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "failed_before_send",
    );
    expect(
      await exec.all("SELECT event_json FROM warehouse_reprint_events WHERE sequence=3"),
    ).toEqual([{ event_json: expect.stringContaining('"errorCode":"owner_changed"') }]);
    current = true;
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "failed_before_send",
    );
    await reprintWarehouseJob(
      {
        exec,
        owner: input.owner,
        operatorId: input.operatorId,
        profile: input.printer,
        isCurrent: () => current,
        print: async () => {
          calls += 1;
        },
      },
      input.jobId,
      "not_printed",
    );
    // The injected retirement also catches the new claim; neither invocation reaches hardware.
    expect(calls).toBe(0);
  } finally {
    db.close();
  }
});
it("recovers an interrupted sending claim with no live process transport as unknown", async () => {
  const db = new DatabaseSync(":memory:");
  const exec = makeRotatingExec([db, db]);
  await applyMigrations(exec);
  const input = await prepare(exec);
  try {
    await appendWarehouseEvent(exec, input.owner, {
      kind: "sending",
      eventId: crypto.randomUUID(),
      sequence: 2,
      jobId: input.jobId,
      sessionId: input.sessionId,
      attemptId: input.preparedEvent.attemptId,
      operatorId: input.operatorId,
      occurredAt: input.preparedEvent.occurredAt,
    });
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect((await readWarehouseJob(exec, input.owner, input.jobId)).projection.state).toBe(
      "delivery_unknown",
    );
    expect(
      await exec.all("SELECT event_json FROM warehouse_reprint_events WHERE sequence=3"),
    ).toEqual([{ event_json: expect.stringContaining('"errorCode":"interrupted"') }]);
  } finally {
    db.close();
  }
});

it("recovers another owner's interrupted job while unrelated transport remains alive", async () => {
  const liveDb = new DatabaseSync(":memory:");
  const otherDb = new DatabaseSync(":memory:");
  const liveExec = makeRotatingExec([liveDb, liveDb]);
  const otherExec = makeRotatingExec([otherDb, otherDb]);
  await applyMigrations(liveExec);
  await applyMigrations(otherExec);
  const live = await prepare(liveExec);
  const other = await prepare(otherExec, "another-owner");
  const entered = deferred();
  const release = deferred();
  const send = printWarehouseJob(
    {
      exec: liveExec,
      owner: live.owner,
      operatorId: live.operatorId,
      profile: live.printer,
      isCurrent: () => true,
      print: async () => {
        entered.resolve();
        await release.promise;
      },
    },
    live.jobId,
  );
  await entered.promise;
  try {
    await appendWarehouseEvent(otherExec, other.owner, {
      kind: "sending",
      eventId: crypto.randomUUID(),
      sequence: 2,
      jobId: other.jobId,
      sessionId: other.sessionId,
      attemptId: other.preparedEvent.attemptId,
      operatorId: other.operatorId,
      occurredAt: other.preparedEvent.occurredAt,
    });
    await recoverWarehouseJobs(otherExec, other.owner, other.operatorId);
    expect((await readWarehouseJob(otherExec, other.owner, other.jobId)).projection.state).toBe(
      "delivery_unknown",
    );
    expect((await readWarehouseJob(liveExec, live.owner, live.jobId)).projection.state).toBe(
      "sending",
    );
  } finally {
    release.resolve();
    await send;
    liveDb.close();
    otherDb.close();
  }
});
it("recovers metadata without loading saved bytes for jobs that have no sending claim", async () => {
  const db = new DatabaseSync(":memory:");
  const raw = makeRotatingExec([db, db]);
  await applyMigrations(raw);
  const input = await prepare(raw);
  let payloadReads = 0;
  const exec: SqlExecutor = {
    run: raw.run,
    all: async <T>(sql: string, params?: unknown[]) => {
      const rows = await raw.all<T>(sql, params);
      for (const row of rows)
        if (typeof row === "object" && row !== null && "job_json" in row) payloadReads += 1;
      return rows;
    },
  };
  try {
    await recoverWarehouseJobs(exec, input.owner, input.operatorId);
    expect(payloadReads).toBe(0);
    expect((await readWarehouseJob(raw, input.owner, input.jobId)).projection.state).toBe(
      "prepared",
    );
    expect(await raw.all("SELECT sequence FROM warehouse_reprint_events")).toEqual([
      { sequence: 1 },
    ]);
  } finally {
    db.close();
  }
});
