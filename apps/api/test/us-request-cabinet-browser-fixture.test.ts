import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@markiro/db";
import * as bootstrap from "../src/deployment/us-bootstrap";
import * as processes from "./support/us-request-worker-process-fixture";
import { startRequestCabinetBrowserFixture } from "./support/us-request-cabinet-browser-fixture";
import {
  createResponseObservation,
  readActionResponseBody,
} from "./support/us-browser-response-body";
import { barrier } from "./support/us-transformation-lock-fixture";

const url = process.env.US_TEST_DATABASE_URL;
afterEach(() => vi.restoreAllMocks());

describe("Requests browser response body ownership", () => {
  it("captures JSON before the triggering action can invalidate its browser response", async () => {
    const payload = { runId: "synthetic-run", revision: 2 };
    let available = true;
    let respond = (_response: { json(): Promise<unknown> }) => {};
    const response = new Promise<{ json(): Promise<unknown> }>((resolve) => {
      respond = resolve;
    });
    const body = readActionResponseBody(response, async () => {
      respond({
        async json() {
          if (!available) throw new Error("Response body navigated away");
          return payload;
        },
      });
      await nextTurn();
      available = false;
    });
    await expect(body).resolves.toBe(payload);
  });

  it("does not advance the scenario before the triggering action finishes", async () => {
    const action = barrier(),
      read = barrier();
    let completed = false;
    const body = readActionResponseBody(
      Promise.resolve({
        async json() {
          read.release();
          return "captured";
        },
      }),
      () => action.promise,
    ).then((value) => {
      completed = true;
      return value;
    });
    try {
      await read.promise;
      await nextTurn();
      expect(completed).toBe(false);
      action.release();
      await expect(body).resolves.toBe("captured");
    } finally {
      action.release();
      await body;
    }
  });

  it.each([new Error("original JSON failure"), undefined])(
    "preserves the exact response-body failure %s",
    async (failure) => {
      await expect(
        readActionResponseBody(
          Promise.resolve({
            json: async () => {
              throw failure;
            },
          }),
          async () => {},
        ),
      ).rejects.toBe(failure);
    },
  );

  it("handles a rejected response wait while preserving the primary action failure", async () => {
    const responseFailure = new Error("response wait ended"),
      actionFailure = new Error("click failed");
    await expect(
      readActionResponseBody(Promise.reject(responseFailure), async () => {
        throw actionFailure;
      }),
    ).rejects.toBe(actionFailure);
    await nextTurn();
  });
});

describe("Requests finite response observation", () => {
  const response = {
    status: 201,
    sameOrigin: true,
    fromServiceWorker: false,
    resourceType: "fetch",
  };
  const output = (observation: ReturnType<typeof createResponseObservation>) => {
    const line = observation.failureLine();
    if (line === undefined) throw new Error("Missing finite observation line");
    expect(line.startsWith("US_REQUEST_CREATE_OBSERVATION ")).toBe(true);
    return JSON.parse(line.slice("US_REQUEST_CREATE_OBSERVATION ".length));
  };

  it("records only finite permitted lifecycle and response fields in order", () => {
    const observation = createResponseObservation();
    observation.record("request-started", 0);
    observation.record("response", 1.5, response);
    observation.record("body-started", 2);
    observation.record("body-failed", 3);
    expect(output(observation)).toEqual({
      records: [
        { event: "request-started", elapsedMs: 0 },
        { event: "response", elapsedMs: 1.5, ...response },
        { event: "body-started", elapsedMs: 2 },
        { event: "body-failed", elapsedMs: 3 },
      ],
      overflow: false,
      invalid: false,
    });
  });

  it("drops extra private fields without invoking their getters or serialization", () => {
    const sentinel = "PRIVATE_CREDENTIAL_SENTINEL";
    const observation = createResponseObservation();
    const hostile = {
      ...response,
      get secret() {
        throw new Error(sentinel);
      },
      toJSON() {
        throw new Error(sentinel);
      },
      url: sentinel,
      headers: { authorization: sentinel },
      body: sentinel,
      cause: new Error(sentinel),
    };
    observation.record("response", 0, hostile);
    const line = observation.failureLine();
    expect(line).not.toContain(sentinel);
    expect(line).toBe(
      'US_REQUEST_CREATE_OBSERVATION {"records":[{"event":"response","elapsedMs":0,"status":201,"sameOrigin":true,"fromServiceWorker":false,"resourceType":"fetch"}],"overflow":false,"invalid":false}',
    );
  });

  it("rejects unknown events, hostile values and response fields without serializing them", () => {
    const sentinel = "PRIVATE_VALUE_SENTINEL";
    const hostile = {
      toString() {
        throw new Error(sentinel);
      },
      toJSON() {
        throw new Error(sentinel);
      },
    };
    const observation = createResponseObservation();
    for (const event of [sentinel, hostile, null, undefined, Symbol(sentinel)])
      observation.record(event, 0);
    for (const value of [
      null,
      undefined,
      hostile,
      { ...response, status: -1 },
      { ...response, status: 600 },
      { ...response, status: 200.5 },
      { ...response, status: Infinity },
      { ...response, sameOrigin: sentinel },
      { ...response, fromServiceWorker: hostile },
      { ...response, resourceType: sentinel },
      { ...response, resourceType: hostile },
      new Proxy(
        {},
        {
          get: () => {
            throw new Error(sentinel);
          },
        },
      ),
    ])
      observation.record("response", 0, value);
    observation.record("body-failed", 0, { secret: sentinel });
    expect(output(observation)).toEqual({ records: [], overflow: false, invalid: true });
  });

  it("rejects nonfinite, negative, nonnumeric and backwards elapsed values", () => {
    const observation = createResponseObservation();
    observation.record("body-started", 4);
    for (const elapsed of [NaN, Infinity, -Infinity, -1, 3, "5", null, {}])
      observation.record("body-failed", elapsed);
    observation.record("body-failed", 4);
    expect(output(observation)).toEqual({
      records: [
        { event: "body-started", elapsedMs: 4 },
        { event: "body-failed", elapsedMs: 4 },
      ],
      overflow: false,
      invalid: true,
    });
  });

  it("bounds records, reports overflow and freezes a stopped failure line exactly once", () => {
    const observation = createResponseObservation();
    for (let elapsed = 0; elapsed < 100; elapsed++) observation.record("request-finished", elapsed);
    observation.stop();
    observation.record("page-close", 101);
    observation.record("private", NaN);
    const result = output(observation);
    expect(result.records).toHaveLength(32);
    expect(result.records[31]).toEqual({ event: "request-finished", elapsedMs: 31 });
    expect(result.overflow).toBe(true);
    expect(result.invalid).toBe(false);
    expect(observation.failureLine()).toBeUndefined();
  });

  it("supports every pinned resource type and only closed lifecycle events", () => {
    const observation = createResponseObservation();
    for (const resourceType of [
      "document",
      "stylesheet",
      "image",
      "media",
      "font",
      "script",
      "texttrack",
      "xhr",
      "fetch",
      "eventsource",
      "websocket",
      "manifest",
      "other",
    ])
      observation.record("response", 0, { ...response, resourceType });
    for (const event of [
      "action-started",
      "action-settled",
      "action-failed",
      "body-settled",
      "request-failed",
      "main-frame-navigation",
      "child-frame-navigation",
      "page-close",
      "page-crash",
    ])
      observation.record(event, 0);
    const result = output(observation);
    expect(result.records).toHaveLength(22);
    expect(result.invalid).toBe(false);
    expect(result.overflow).toBe(false);
  });

  it("accepts boundary statuses, copies primitive fields and does not report overflow at exactly 32 records", () => {
    const observation = createResponseObservation();
    const input = { ...response, status: 0 };
    observation.record("response", 0, input);
    input.status = 599;
    observation.record("response", 0, input);
    input.resourceType = "PRIVATE_AFTER_RECORD";
    for (let index = 0; index < 30; index++) observation.record("request-finished", 0);
    const result = output(observation);
    expect(result.records).toHaveLength(32);
    expect(result.records.slice(0, 2)).toEqual([
      {
        event: "response",
        elapsedMs: 0,
        status: 0,
        sameOrigin: true,
        fromServiceWorker: false,
        resourceType: "fetch",
      },
      {
        event: "response",
        elapsedMs: 0,
        status: 599,
        sameOrigin: true,
        fromServiceWorker: false,
        resourceType: "fetch",
      },
    ]);
    expect(result.overflow).toBe(false);
    expect(result.invalid).toBe(false);
  });

  it("observes the one real operation without changing this-binding, payload or completion", async () => {
    const observation = createResponseObservation();
    const gate = barrier();
    const payload = { receipt: "real-operation-result" };
    let calls = 0,
      elapsed = 0;
    const actual = {
      async json() {
        expect(this).toBe(actual);
        calls++;
        await gate.promise;
        return payload;
      },
    };
    const pending = observation.observe(
      "body",
      () => elapsed,
      () => actual.json(),
    );
    try {
      expect(calls).toBe(1);
      elapsed = 2;
      gate.release();
      await expect(pending).resolves.toBe(payload);
    } finally {
      gate.release();
      await pending;
    }
    expect(output(observation)).toEqual({
      records: [
        { event: "body-started", elapsedMs: 0 },
        { event: "body-settled", elapsedMs: 2 },
      ],
      overflow: false,
      invalid: false,
    });
  });

  it.each([new Error("PRIVATE_OPERATION_FAILURE"), undefined])(
    "never masks the original operation failure with invalid clock data",
    async (failure) => {
      const observation = createResponseObservation();
      await expect(
        observation.observe(
          "action",
          () => {
            throw new Error("PRIVATE_CLOCK");
          },
          async () => {
            throw failure;
          },
        ),
      ).rejects.toBe(failure);
      expect(output(observation)).toEqual({ records: [], overflow: false, invalid: true });
    },
  );

  it("records synchronous action failure and blocks late observation after stop", async () => {
    const observation = createResponseObservation();
    const failure = new Error("PRIVATE_ACTION_FAILURE");
    await expect(
      observation.observe(
        "action",
        () => 0,
        () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    observation.stop();
    await observation.observe(
      "body",
      () => {
        throw new Error("PRIVATE_LATE_CLOCK");
      },
      async () => "late",
    );
    expect(output(observation)).toEqual({
      records: [
        { event: "action-started", elapsedMs: 0 },
        { event: "action-failed", elapsedMs: 0 },
      ],
      overflow: false,
      invalid: false,
    });
  });

  it("characterizes delayed protocol loss after JSON entry as the exact original failure, with work drained", async () => {
    const entered = barrier(),
      finished = barrier(),
      action = barrier();
    const failure = new Error("unavailable-body");
    let available = true,
      drained = false;
    const pending = readActionResponseBody(
      Promise.resolve({
        async json() {
          entered.release();
          await finished.promise;
          if (!available) throw failure;
          return "unused";
        },
      }),
      async () => {
        await entered.promise;
        available = false;
        finished.release();
        await action.promise;
        drained = true;
      },
    );
    const observed = pending.then(
      () => ({ resolved: true }),
      (error: unknown) => ({ error }),
    );
    try {
      await entered.promise;
      action.release();
      const result = await observed;
      if (!("error" in result)) throw new Error("Expected the original unavailable-body failure");
      expect(result.error).toBe(failure);
      expect(drained).toBe(true);
    } finally {
      entered.release();
      finished.release();
      action.release();
      await observed;
    }
  });
});

async function assertDatabaseRemoved(name: string) {
  if (!url || !/^markiro_us_profile_[a-f0-9_]+$/.test(name))
    throw new Error("Explicit owned database required");
  const connection = createDb(url);
  try {
    const result = await connection.pool.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS present",
      [name],
    );
    expect(result.rows[0]?.present).toBe(false);
  } finally {
    await connection.pool.end();
  }
}

describe("Requests cabinet fixture boundaries", () => {
  it.each([
    undefined,
    "",
    "postgres://x@remote.test/production",
    "postgres://markiro_us@127.0.0.1:55432/other",
  ])(
    "rejects an invalid explicit URL before acquisition and never falls back to DATABASE_URL",
    async (raw) => {
      const acquire = vi.spyOn(processes, "createWorkerProcessFixture");
      await expect(startRequestCabinetBrowserFixture(raw as string)).rejects.toThrow();
      expect(acquire).not.toHaveBeenCalled();
    },
  );
});

describe.skipIf(url === undefined)("Configured owned Requests cabinet lifecycle", () => {
  it.each(["process", "seed", "app", "vite"] as const)(
    "cleans acquired resources exactly once after failure at %s",
    async (stage) => {
      const acquire = vi.spyOn(processes, "createWorkerProcessFixture");
      const applications = vi.spyOn(bootstrap, "createUsDevelopmentApplication");
      let owned: processes.WorkerProcessFixture | undefined;
      let close: ReturnType<typeof vi.spyOn> | undefined;
      const stages: string[] = [];
      let name: string | undefined;
      let closeApp: ReturnType<typeof vi.spyOn> | undefined;
      await expect(
        startRequestCabinetBrowserFixture(url!, {
          async afterAcquire(current) {
            stages.push(current);
            if (current === "process") {
              owned = await acquire.mock.results[0]?.value;
              if (!owned) throw new Error("Missing owned fixture observation");
              close = vi.spyOn(owned, "close");
              name = (
                await owned.database.pool.query<{ name: string }>(
                  "SELECT current_database() AS name",
                )
              ).rows[0]?.name;
            }
            if (current === "app") {
              const app = await applications.mock.results[0]?.value;
              if (!app) throw new Error("Missing owned application observation");
              closeApp = vi.spyOn(app, "close");
            }
            if (current === stage) throw new Error("Injected acquisition failure");
          },
        }),
      ).rejects.toThrow("Requests browser fixture could not start");
      expect(close).toHaveBeenCalledTimes(1);
      expect(stages).toContain(stage);
      if (stage === "app" || stage === "vite") expect(closeApp).toHaveBeenCalledTimes(1);
      if (!owned) throw new Error("Owned fixture not observed");
      await expect(access(owned.build.root)).rejects.toThrow();
      expect(owned.objects.size).toBe(0);
      if (!name) throw new Error("Missing owned database identity");
      await assertDatabaseRemoved(name);
    },
    45_000,
  );

  it("identity lookup failure cannot bypass process cleanup", async () => {
    const acquire = vi.spyOn(processes, "createWorkerProcessFixture");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    await expect(
      startRequestCabinetBrowserFixture(url!, {
        async afterAcquire(stage) {
          if (stage !== "process") return;
          const owned: processes.WorkerProcessFixture = await acquire.mock.results[0]?.value;
          close = vi.spyOn(owned, "close");
          vi.spyOn(owned.database.pool, "query").mockRejectedValueOnce(
            new Error("Private diagnostic"),
          );
        },
      }),
    ).rejects.toThrow("Requests browser fixture could not start");
    expect(close).toHaveBeenCalledTimes(1);
  }, 45_000);

  it("owned build disposal failure cannot bypass database cleanup", async () => {
    const acquire = vi.spyOn(processes, "createWorkerProcessFixture");
    const fixture = await startRequestCabinetBrowserFixture(url!);
    const owned: processes.WorkerProcessFixture = await acquire.mock.results[0]?.value;
    const dispose = vi
      .spyOn(owned.build, "dispose")
      .mockRejectedValueOnce(new Error("Injected owned build disposal failure"));
    const closeDatabase = vi.spyOn(owned.database, "close");
    let closeAttempted = false;
    try {
      const name = (
        await owned.database.pool.query<{ name: string }>("SELECT current_database() AS name")
      ).rows[0]?.name;
      closeAttempted = true;
      await expect(fixture.close()).rejects.toThrow("Injected owned build disposal failure");
      expect(closeDatabase).toHaveBeenCalledTimes(1);
      if (!name) throw new Error("Missing owned database identity");
      await assertDatabaseRemoved(name);
      await access(owned.build.root);
    } finally {
      try {
        if (!closeAttempted) await fixture.close();
      } finally {
        dispose.mockRestore();
        try {
          // The fault deliberately retained only this invocation's copied build.
          await owned.build.dispose();
        } finally {
          // RED must not leak its owned DB when the old cleanup skips this step.
          if (closeDatabase.mock.calls.length === 0) await owned.database.close();
        }
      }
    }
    await expect(access(owned.build.root)).rejects.toThrow();
  }, 45_000);

  it("close is idempotent and releases both owned listeners", async () => {
    const acquire = vi.spyOn(processes, "createWorkerProcessFixture");
    const fixture = await startRequestCabinetBrowserFixture(url!);
    const owned: processes.WorkerProcessFixture = await acquire.mock.results[0]?.value;
    const close = vi.spyOn(owned, "close");
    try {
      expect(fixture.origin).toBe("http://localhost:5174");
      expect(fixture.workerPid()).toBeNull();
    } finally {
      await fixture.close();
      await fixture.close();
    }
    expect(close).toHaveBeenCalledTimes(1);
    for (const port of [3100, 5174]) {
      const probe = createServer();
      try {
        await new Promise<void>((resolve, reject) => {
          probe.once("error", reject);
          probe.listen(port, "127.0.0.1", resolve);
        });
      } finally {
        await new Promise<void>((resolve, reject) =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }, 45_000);
});
