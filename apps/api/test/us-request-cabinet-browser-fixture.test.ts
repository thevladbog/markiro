import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@markiro/db";
import * as bootstrap from "../src/deployment/us-bootstrap";
import * as processes from "./support/us-request-worker-process-fixture";
import { startRequestCabinetBrowserFixture } from "./support/us-request-cabinet-browser-fixture";
import { readActionResponseBody } from "./support/us-browser-response-body";
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
