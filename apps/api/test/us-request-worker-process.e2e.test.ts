import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localBuildEnv } from "./support/us-request-build-fixture";
import { storageEnvironment } from "./support/us-request-worker-storage-fixture";
import { createDb } from "@markiro/db";
import type { createUsProfileTestDatabase } from "./support/us-profile-database";
import {
  createWorkerProcessFixture,
  waitFor,
  type WorkerProcessFixture,
} from "./support/us-request-worker-process-fixture";

const url = process.env.US_TEST_DATABASE_URL;
async function exitWithin<T>(exited: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned child exit deadline exceeded")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
type Process = Awaited<ReturnType<WorkerProcessFixture["spawn"]>>;
type Evidence = Awaited<ReturnType<WorkerProcessFixture["readEvidence"]>>;
const noPrivateLogs = (child: Process, evidence?: Evidence) => {
  expect(child.output()).not.toMatch(
    /private@example|Synthetic subprocess requester|postgres:|leaseToken|SELECT|INSERT|08007|synthetic-us-request-secret/,
  );
  if (evidence)
    for (const attempt of evidence.attempts) expect(child.output()).not.toContain(attempt.token);
  for (const line of child.output().trim().split("\n").filter(Boolean)) {
    if (line === "us_request_worker_force_exit") continue;
    const event: unknown = JSON.parse(line);
    expect(event).toMatchObject({
      event: expect.stringMatching(/^(started|result|iteration_failed|stopping|stopped)$/),
      completedIterations: expect.any(Number),
    });
    if (!event || typeof event !== "object") throw new Error("Missing lifecycle diagnostic");
    expect(Object.keys(event).sort()).toEqual(
      "kind" in event ? ["completedIterations", "event", "kind"] : ["completedIterations", "event"],
    );
  }
};
const assertWinner = (
  e: Evidence,
  attemptNumber: number,
  mode: "export_ready" | "available_records_incomplete",
) => {
  expect(e.run.status).toBe("ready");
  expect(e.successfulPublications).toBe(1);
  expect(e.artifacts).toHaveLength(mode === "export_ready" ? 6 : 5);
  expect(e.artifactHashes).toEqual(e.artifacts.map((artifact) => artifact.sha256));
  const winning = e.attempts.find((attempt) => attempt.status === "succeeded");
  expect(winning?.attemptNumber).toBe(attemptNumber);
  expect(e.attempts.filter((attempt) => attempt.status === "succeeded")).toHaveLength(1);
  expect(e.intents.filter((intent) => intent.state === "referenced")).toHaveLength(
    e.artifacts.length,
  );
  for (const artifact of e.artifacts)
    expect(e.intents.find((intent) => intent.objectKey === artifact.objectKey)).toMatchObject({
      state: "referenced",
      sha256: artifact.sha256,
    });
  expect(e.audits[0]).toMatchObject({
    organizationId: e.scope.tenantId,
    actorUserId: null,
    action: "traceability.request.worker.published",
    outcome: "success",
    targetType: "trace_export_run",
    targetId: e.run.id,
    before: null,
    createdAt: e.run.completedAt,
    after: {
      actorKind: "system",
      initiatorId: e.scope.actorId,
      requestId: e.scope.requestId,
      runId: e.run.id,
      runRevision: e.run.revision,
      mode,
      attemptId: winning?.id,
      attemptNumber,
      cycle: 1,
      cycleAttemptCount: attemptNumber,
      lifecycleVersion: e.run.lifecycleVersion,
      commandDigest: e.run.commandDigest,
      scopedContentDigest: e.run.scopedContentDigest,
      inputDigest: e.run.inputDigest,
      artifacts: e.intents
        .filter((intent) => intent.state === "referenced")
        .map((intent) => ({
          name: intent.name,
          kind: intent.kind,
          sha256: intent.sha256,
          byteSize: Number(intent.byteSize),
        })),
    },
  });
};

it("actual unchanged CLI rejects unexpected arguments before runtime regardless of build cleanliness", async () => {
  const child = spawn(
    process.execPath,
    [resolve("dist/main.us-request-worker.js"), "unexpected-test-argument"],
    {
      env: { ...(await localBuildEnv()), ...storageEnvironment() },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const exited = new Promise((done) =>
    child.once("exit", (code, signal) => done({ code, signal })),
  );
  try {
    expect(await exitWithin(exited)).toEqual({ code: 1, signal: null });
    expect(output).toBe("us_request_worker_startup_refused\n");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  }
});

describe.skipIf(!url)(
  "compiled composition real subprocess matrix with owned PostgreSQL and parent provider double",
  () => {
    let fixture: WorkerProcessFixture;
    beforeEach(async () => {
      if (!url) throw new Error("Explicit synthetic US URL required");
      fixture = await createWorkerProcessFixture(url);
    }, 60_000);
    afterEach(async () => {
      await fixture?.close();
    }, 30_000);

    it("guarantees CLI refusal before runtime with a valid clean default-root descriptor", async () => {
      if (!url) throw new Error("Explicit owned fixture required");
      const databaseName = (
        await fixture.database.pool.query<{ name: string }>("SELECT current_database() AS name")
      ).rows[0]?.name;
      const ownedUrl = new URL(url);
      ownedUrl.pathname = `/${databaseName}`;
      const child = fork(resolve("test/support/us-request-worker-process-child.mjs"), [], {
        env: {},
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let checked = false;
      let runtimeReached = false;
      child.on("message", (value: unknown) => {
        if (value && typeof value === "object" && "type" in value) {
          if (value.type === "descriptor_checked") checked = true;
          if (value.type === "runtime_boundary_reached") runtimeReached = true;
        }
      });
      const exited = new Promise((done) =>
        child.once("exit", (code, signal) => done({ code, signal })),
      );
      try {
        child.send({
          type: "initialize",
          mode: "cli_probe",
          raw: { ...(await localBuildEnv()), ...storageEnvironment() },
          ownedUrl: ownedUrl.toString(),
          databaseName,
          roots: fixture.build.roots,
          arguments: ["unexpected-test-argument"],
        });
        expect(await exitWithin(exited)).toEqual({ code: 1, signal: null });
        expect(checked).toBe(true);
        expect(runtimeReached).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await exited;
      }
    });

    it.each(["SIGTERM", "SIGINT"] as const)(
      "settles actual idle %s with graceful PID exit",
      async (signal) => {
        const child = await fixture.spawn();
        expect(child.pid).toBeGreaterThan(0);
        await waitFor(async () => (child.output().includes('"kind":"idle"') ? true : undefined));
        child.signal(signal);
        expect(await child.exited).toEqual({ code: 0, signal: null });
        noPrivateLogs(child);
        expect(child.output().match(/"event":"stopping"/g)).toHaveLength(1);
        expect(child.output().match(/"event":"stopped"/g)).toHaveLength(1);
      },
    );

    it("finishes in-flight bytes after repeated signals and stops claiming the next run", async () => {
      const firstScope = await fixture.seedRun("export_ready");
      const hold = await fixture.holdNextUpload();
      const child = await fixture.spawn();
      await hold.entered;
      const nextScope = await fixture.seedRun("available_records_incomplete");
      child.signal("SIGTERM");
      await waitFor(async () => (child.output().includes('"event":"stopping"') ? true : undefined));
      child.signal("SIGINT");
      child.signal("SIGTERM");
      hold.release();
      expect(await child.exited).toEqual({ code: 0, signal: null });
      const winner = await fixture.readEvidence(firstScope.runId);
      assertWinner(winner, 1, "export_ready");
      const next = await fixture.readEvidence(nextScope.runId);
      expect(next.run.status).toBe("queued");
      expect(next.attemptCount).toBe(0);
      expect(child.output().match(/"event":"stopping"/g)).toHaveLength(1);
      noPrivateLogs(child, winner);
    }, 30_000);

    it("forces actual exit after the unchanged 30-second drain while a forwarded COMMIT reply is held", async () => {
      const scope = await fixture.seedRun("available_records_incomplete");
      const hold = fixture.holdNextPublicationReply();
      const child = await fixture.spawn("hold_reply");
      await hold.entered;
      const winner = await fixture.readEvidence(scope.runId);
      assertWinner(winner, 1, "available_records_incomplete");
      const next = await fixture.seedRun("available_records_incomplete");
      const start = performance.now();
      child.signal("SIGTERM");
      await waitFor(async () => (child.output().includes('"event":"stopping"') ? true : undefined));
      child.signal("SIGINT");
      expect(await child.exited).toEqual({ code: 1, signal: null });
      expect(performance.now() - start).toBeGreaterThanOrEqual(29_900);
      expect(child.output()).toContain("us_request_worker_force_exit");
      expect((await fixture.readEvidence(next.runId)).attemptCount).toBe(0);
      assertWinner(await fixture.readEvidence(scope.runId), 1, "available_records_incomplete");
      hold.release();
      noPrivateLogs(child, winner);
    }, 50_000);

    it("SIGKILL recovery waits for actual unchanged 120-second PostgreSQL lease and preserves frozen checkpoint", async () => {
      const scope = await fixture.seedRun("available_records_incomplete");
      const hold = await fixture.holdNextUpload(1);
      const first = await fixture.spawn();
      await hold.entered;
      const before = await fixture.readEvidence(scope.runId);
      expect(before.checkpoint).not.toBeNull();
      expect(before.attemptCount).toBe(1);
      const privateBefore = new Map(
        [...fixture.objects]
          .filter(([key]) => key.startsWith("markiro-us-request-fixture/"))
          .map(([key, object]) => [
            key,
            {
              bytes: Buffer.from(object.bytes),
              sha256: createHash("sha256").update(object.bytes).digest("hex"),
            },
          ]),
      );
      expect(privateBefore.size).toBeGreaterThanOrEqual(1);
      for (const [key, previous] of privateBefore) {
        expect(
          before.intents.find((intent) => `markiro-us-request-fixture/${intent.objectKey}` === key),
        ).toMatchObject({
          state: "verified",
          sha256: previous.sha256,
          byteSize: BigInt(previous.bytes.length),
        });
      }
      const lease = before.run.leaseExpiresAt;
      const attempt = before.attempts[0];
      if (!lease || !attempt) throw new Error("Durable lease required");
      expect(lease.getTime() - attempt.startedAt.getTime()).toBe(120_000);
      const start = performance.now();
      first.signal("SIGKILL");
      expect(await first.exited).toEqual({ code: null, signal: "SIGKILL" });
      for (const [key, previous] of privateBefore) {
        const afterExit = fixture.objects.get(key);
        expect(afterExit?.bytes).toEqual(previous.bytes);
        expect(afterExit && createHash("sha256").update(afterExit.bytes).digest("hex")).toBe(
          previous.sha256,
        );
      }
      const second = await fixture.spawn();
      expect(second.pid).not.toBe(first.pid);
      await waitFor(async () => (second.output().includes('"kind":"idle"') ? true : undefined));
      const live = await fixture.database.pool.query<{ live: boolean }>(
        "SELECT clock_timestamp() < $1::timestamptz AS live",
        [lease],
      );
      expect(live.rows[0]?.live).toBe(true);
      expect((await fixture.readEvidence(scope.runId)).attemptCount).toBe(1);
      await waitFor(async () => {
        const time = await fixture.database.pool.query<{ eligible: boolean }>(
          "SELECT clock_timestamp() >= $1::timestamptz AS eligible",
          [lease],
        );
        return time.rows[0]?.eligible ? true : undefined;
      }, 130_000);
      await fixture.waitForReady(scope.runId);
      const after = await fixture.readEvidence(scope.runId);
      expect(after.frozenInput).toEqual(before.frozenInput);
      expect(after.checkpoint).toEqual(before.checkpoint);
      expect(after.attemptCount).toBe(2);
      const recovered = after.attempts.find((a) => a.attemptNumber === 2);
      expect(recovered?.startedAt.getTime()).toBeGreaterThanOrEqual(lease.getTime());
      assertWinner(after, 2, "available_records_incomplete");
      second.signal("SIGTERM");
      expect(await second.exited).toEqual({ code: 0, signal: null });
      hold.release();
      noPrivateLogs(first, before);
      noPrivateLogs(second, after);
      console.info(
        `actual lease recovery elapsed milliseconds=${Math.round(performance.now() - start)} persisted lease milliseconds=120000`,
      );
    }, 180_000);

    it("rechecks authority after an actual membership row lock and commits no publication", async () => {
      const scope = await fixture.seedRun("available_records_incomplete");
      const hold = await fixture.holdNextUpload();
      const child = await fixture.spawn();
      await hold.entered;
      const before = await fixture.readEvidence(scope.runId);
      const revoker = await fixture.database.pool.connect();
      try {
        await revoker.query("BEGIN");
        await revoker.query("SELECT id FROM member WHERE id=$1 FOR UPDATE", [
          before.scope.memberId,
        ]);
        hold.release();
        await waitFor(async () => {
          const r = await fixture.database.pool.query<{ blocked: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%member%') AS blocked",
          );
          return r.rows[0]?.blocked ? true : undefined;
        });
        await revoker.query("UPDATE member SET role='viewer' WHERE id=$1", [before.scope.memberId]);
        await revoker.query("COMMIT");
        await waitFor(async () => (child.output().includes('"event":"result"') ? true : undefined));
        child.signal("SIGTERM");
        expect(await child.exited).toEqual({ code: 0, signal: null });
        const after = await fixture.readEvidence(scope.runId);
        expect(after.successfulPublications).toBe(0);
        expect(after.artifacts).toEqual([]);
        expect(after.frozenInput).toEqual(before.frozenInput);
        expect(after.checkpoint).toEqual(before.checkpoint);
        expect(after.intents.some((intent) => intent.state === "referenced")).toBe(false);
        noPrivateLogs(child, after);
      } finally {
        await revoker.query("ROLLBACK");
        revoker.release();
      }
    }, 30_000);

    it("reconciles a genuinely forwarded publication COMMIT with a lost reply without deleting winner bytes", async () => {
      const scope = await fixture.seedRun("export_ready");
      const commit = fixture.holdNextPublicationReply();
      const child = await fixture.spawn("lose_reply");
      await commit.entered;
      const committed = await fixture.readEvidence(scope.runId);
      await fixture.waitForReady(scope.runId);
      await waitFor(async () => (child.output().includes('"kind":"ready"') ? true : undefined));
      child.signal("SIGTERM");
      expect(await child.exited).toEqual({ code: 0, signal: null });
      const winner = await fixture.readEvidence(scope.runId);
      expect(winner.frozenInput).toEqual(committed.frozenInput);
      expect(winner.checkpoint).toEqual(committed.checkpoint);
      assertWinner(winner, 1, "export_ready");
      for (const artifact of winner.artifacts)
        expect(
          fixture.calls.some((call) => call.kind === "delete" && call.key === artifact.objectKey),
        ).toBe(false);
      noPrivateLogs(child, winner);
      commit.release();
    }, 30_000);
  },
);

describe.skipIf(!url)("fixture setup failure ownership", () => {
  it.each(["identity", "build"] as const)(
    "unwinds allocated database on %s failure",
    async (phase) => {
      if (!url) throw new Error("Explicit synthetic URL required");
      let allocated: Awaited<ReturnType<typeof createUsProfileTestDatabase>> | undefined;
      let ownedName: string | undefined;
      try {
        await expect(
          createWorkerProcessFixture(url, {
            readIdentity: async (database) => {
              allocated = database;
              ownedName = (
                await database.pool.query<{ name: string }>("SELECT current_database() AS name")
              ).rows[0]?.name;
              if (phase === "identity") throw new Error("Synthetic identity failure");
              return ownedName;
            },
            createBuild: async () => {
              throw new Error("Synthetic build failure");
            },
          }),
        ).rejects.toThrow(`Synthetic ${phase} failure`);
        expect(allocated?.pool.ended).toBe(true);
        if (!ownedName) throw new Error("Missing allocated identity");
        const ownedUrl = new URL(url);
        ownedUrl.pathname = `/${ownedName}`;
        const probe = createDb(ownedUrl.toString());
        try {
          await expect(probe.pool.query("SELECT 1")).rejects.toMatchObject({ code: "3D000" });
        } finally {
          await probe.pool.end();
        }
      } finally {
        // RED failure still removes only the allocation captured by this test.
        if (allocated && !allocated.pool.ended) await allocated.close();
      }
    },
    60_000,
  );
});
