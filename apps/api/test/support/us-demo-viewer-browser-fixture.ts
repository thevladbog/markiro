import "reflect-metadata";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable } from "node:stream";
import { schema, type createDb } from "@markiro/db";
import { canonicalExportDigest } from "@markiro/domain";
import { z } from "zod";
import { usTraceHistoryPageSchema, type UsTraceHistoryPage } from "@markiro/platform-contracts";
import { parseUsDatasetSpecialResult } from "../../src/modules/traceability/demo/us-dataset-special-contract";
import { parseUsDatasetPlanResult } from "../../src/modules/traceability/demo/us-dataset-plan-contract";
import { parseUsDatasetRequestResult } from "../../src/modules/traceability/demo/us-dataset-request-contract";
import { usSixMonthDefinition } from "../../src/modules/traceability/demo/us-six-month-definition";
import { parseUsPlanPublishedRow } from "../../src/modules/traceability/plans/us-plan-published";
import { UsPlanArtifactStore } from "../../src/modules/traceability/plans/us-plan-artifacts";
import { loadUsPlanArtifactStorageConfig } from "../../src/modules/traceability/plans/us-plan-artifact-config";
import { UsRequestPackageArtifactStore } from "../../src/modules/traceability/requests/us-request-package-artifacts";
import { loadUsRequestPackageArtifactStorageConfig } from "../../src/modules/traceability/requests/us-request-package-artifact-config";
import { readUsRequestPublishedState } from "../../src/modules/traceability/requests/us-request-publication-read";
import { requireUsRequestPackageEvidence } from "../../src/modules/traceability/requests/us-request-run-evidence";

const root = resolve(__dirname, "../../../..");
const phases = [
  "installation",
  "initialize",
  "provision",
  "descriptors",
  "ports",
  "application",
  "vite",
  "browser",
  "authentication",
  "journey",
  "snapshot",
  "private-bytes",
  "download",
  "disposal",
] as const;
type Phase = (typeof phases)[number];
type DisposalPhase =
  "context" | "browser" | "vite" | "application" | "private-stores" | "installation";

export type ViewerHistoryExpectation = Pick<
  UsTraceHistoryPage["items"][number],
  | "eventId"
  | "rootId"
  | "type"
  | "eventNumber"
  | "revision"
  | "previousRevisionId"
  | "nextRevisionId"
> & { status: "amended" | "void"; eventDate: string };
export function viewerHistoryPresentation(raw: unknown, expected: ViewerHistoryExpectation) {
  const page = usTraceHistoryPageSchema.parse(raw);
  assert.equal(page.nextCursor, null);
  assert.equal(page.items.length, 1);
  const row = page.items[0];
  assert.ok(row);
  for (const key of Object.keys(expected) as (keyof ViewerHistoryExpectation)[])
    assert.equal(row[key], expected[key]);
  const date = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${expected.eventDate}T12:00:00Z`),
  );
  return {
    eventLabel: `Event ${row.eventNumber} · rev ${row.revision}`,
    statusDate: `${row.status === "amended" ? "Amended" : "Void"} · ${date}`,
  };
}

export function viewerBrowserFailure(phase: unknown): Error {
  return new Error(
    `Viewer browser failed: ${typeof phase === "string" && phases.some((value) => value === phase) ? phase : "unknown"}`,
  );
}
/** Never retain errors: Playwright call logs may contain secret fill arguments or DOM. */
export async function viewerBrowserPhase<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch {
    throw viewerBrowserFailure(phase);
  }
}
/** Failure-only resource disposal; no identity, acquisition or auth success seam. */
export async function disposeViewerBrowserResources(
  stages: readonly { phase: DisposalPhase; dispose(): void | Promise<void> }[],
  deadline = performance.now() + 60_000,
): Promise<void> {
  const failures: Error[] = [];
  let pending = stages.length;
  const run = async (stage: (typeof stages)[number]) => {
    try {
      await stage.dispose();
    } catch {
      const phase = [
        "context",
        "browser",
        "vite",
        "application",
        "private-stores",
        "installation",
      ].includes(stage.phase)
        ? stage.phase
        : "unknown";
      failures.push(new Error(`Viewer browser disposal failed: ${phase}`));
    } finally {
      pending--;
    }
  };
  // Independent shutdown starts synchronously, before any pending close is awaited.
  const independent = stages.filter((stage) => stage.phase !== "installation").map(run);
  const work = (async () => {
    await Promise.all(independent);
    await Promise.all(stages.filter((stage) => stage.phase === "installation").map(run));
    if (failures.length) throw new AggregateError(failures, "Viewer browser disposal failed");
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Viewer browser disposal incomplete: pending=${pending}`)),
          Math.max(0, deadline - performance.now()),
        );
      }),
    ]);
    if (performance.now() >= deadline)
      throw new Error(`Viewer browser disposal incomplete: pending=${pending}`);
  } finally {
    clearTimeout(timer);
  }
}

/** One invocation, one charged setup budget, and one optional native initialize pause.
 * Pending work stays observed after failure. This class cannot confer CI/auth success. */
export class ViewerSetupDeadline {
  readonly startedAt = performance.now();
  private deadline = this.startedAt + 60_000;
  private terminal = false;
  private paused = false;
  private initialized = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly failure: Promise<never>;
  private reject!: (error: Error) => void;
  constructor(private readonly cancel: () => void) {
    this.failure = new Promise<never>((_, reject) => {
      this.reject = reject;
    });
    void this.failure.catch(() => {});
    this.arm();
  }
  private arm() {
    this.timer = setTimeout(() => this.stop(), Math.max(0, this.deadline - performance.now()));
  }
  remaining() {
    if (this.terminal || performance.now() >= this.deadline) {
      this.stop();
      throw viewerBrowserFailure("disposal");
    }
    return Math.floor(this.deadline - performance.now());
  }
  stop() {
    if (this.terminal) return;
    this.terminal = true;
    clearTimeout(this.timer);
    this.reject(new Error(`Viewer browser setup incomplete: pending=${this.pending.size}`));
    this.cancel();
  }
  private observe<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work);
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work),
    );
    return work;
  }
  async run<T>(
    phase: Phase,
    action: () => Promise<T>,
    lateClose?: (value: T) => Promise<void>,
  ): Promise<T> {
    this.remaining();
    const work = this.observe(
      Promise.resolve()
        .then(() => {
          this.remaining();
          return action();
        })
        .then(async (value) => {
          // Monotonic check wins even when resolution and expiry share a timer tick.
          if (this.terminal || performance.now() >= this.deadline) {
            this.stop();
            if (lateClose) await lateClose(value);
            throw viewerBrowserFailure(phase);
          }
          return value;
        }),
    );
    try {
      return await Promise.race([work, this.failure]);
    } catch {
      this.stop();
      throw viewerBrowserFailure(phase);
    }
  }
  async initialize<T>(action: () => Promise<T>): Promise<T> {
    this.remaining();
    if (this.initialized) {
      this.stop();
      throw viewerBrowserFailure("initialize");
    }
    this.initialized = true;
    this.paused = true;
    const remainder = this.deadline - performance.now();
    clearTimeout(this.timer);
    this.deadline = performance.now() + 900_000;
    this.arm();
    try {
      return await this.run("initialize", action);
    } finally {
      clearTimeout(this.timer);
      this.paused = false;
      if (!this.terminal) {
        this.deadline = performance.now() + remainder;
        this.arm();
      }
    }
  }
  finish() {
    this.remaining();
    if (this.paused) throw viewerBrowserFailure("initialize");
    clearTimeout(this.timer);
  }
  async drain() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
  pendingCount() {
    return this.pending.size;
  }
}

/** Normal stop first; exact invocation-owned handles only. Any escalation is a failure. */
export function viewerOwnedShutdown(
  owner: {
    normal(): void | Promise<void>;
    terminate(): void | Promise<void>;
    kill(): void | Promise<void>;
    drained: Promise<void>;
  },
  deadline: () => number = () => performance.now() + 60_000,
) {
  let closing: Promise<void> | undefined;
  return () =>
    (closing ??= (async () => {
      let failed = false;
      const observe = (action: () => void | Promise<void>) => {
        try {
          return Promise.resolve(action()).catch(() => {
            failed = true;
          });
        } catch {
          failed = true;
          return Promise.resolve();
        }
      };
      const pending: Promise<void>[] = [];
      let drained = false;
      const actualDrain = owner.drained.then(
        () => {
          drained = true;
        },
        () => {
          failed = true;
        },
      );
      const end = deadline();
      const term = setTimeout(
        () => {
          if (!drained) {
            failed = true;
            pending.push(observe(owner.terminate));
          }
        },
        Math.max(0, end - performance.now() - 10_000),
      );
      const kill = setTimeout(
        () => {
          if (!drained) {
            failed = true;
            pending.push(observe(owner.kill));
          }
        },
        Math.max(0, end - performance.now() - 5_000),
      );
      try {
        pending.push(observe(owner.normal));
        await actualDrain;
        await Promise.all(pending);
        if (failed) throw viewerBrowserFailure("disposal");
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
      }
    })());
}
export async function requireViewerFreePort(port: number, host: "localhost" | "127.0.0.1") {
  const probe = createServer();
  try {
    await new Promise<void>((done, fail) => {
      probe.once("error", fail);
      probe.listen(port, host, done);
    });
  } catch {
    throw viewerBrowserFailure("ports");
  } finally {
    if (probe.listening)
      await new Promise<void>((done, fail) =>
        probe.close((error) => (error ? fail(viewerBrowserFailure("ports")) : done())),
      );
  }
}

// Structural bridge to the separately installed, pinned Playwright library. No runner config.
export interface ViewerLocator {
  getByRole(role: string, options?: { name: string | RegExp; exact?: boolean }): ViewerLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): ViewerLocator;
  filter(options: { has?: ViewerLocator; hasText?: string | RegExp }): ViewerLocator;
  locator(selector: string): ViewerLocator;
  click(): Promise<void>;
  fill(value: string): Promise<void>;
  check(): Promise<void>;
  pressSequentially(value: string): Promise<void>;
  textContent(): Promise<string | null>;
  selectOption(value: string): Promise<unknown>;
  focus(): Promise<void>;
  count(): Promise<number>;
}
export interface ViewerResponse {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  request(): { method(): string };
  json(): Promise<unknown>;
  body(): Promise<Buffer>;
}
export interface ViewerPage {
  close(): Promise<void>;
  getByRole(role: string, options?: { name: string | RegExp; exact?: boolean }): ViewerLocator;
  getByLabel(label: string, options?: { exact?: boolean }): ViewerLocator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): ViewerLocator;
  locator(selector: string): ViewerLocator;
  goto(url: string): Promise<unknown>;
  setDefaultTimeout(ms: number): void;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  screenshot(options: { fullPage: boolean }): Promise<Buffer>;
  waitForResponse(predicate: (response: ViewerResponse) => boolean): Promise<ViewerResponse>;
  waitForEvent(event: "download"): Promise<{
    suggestedFilename(): string;
    createReadStream(): Promise<Readable>;
    delete(): Promise<void>;
  }>;
  route(
    pattern: string,
    callback: (route: {
      request(): { url(): string };
      continue(): Promise<void>;
      abort(): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  on(event: "pageerror", callback: () => void): void;
  keyboard: { press(key: string): Promise<void> };
}
export interface ViewerAssertions {
  toBeVisible(): Promise<void>;
  toHaveCount(value: number): Promise<void>;
  toHaveText(value: string | RegExp): Promise<void>;
  toContainText(value: string | RegExp): Promise<void>;
  toHaveAttribute(name: string, value: string): Promise<void>;
  toBeFocused(): Promise<void>;
}
interface ViewerContext {
  newPage(): Promise<ViewerPage>;
  close(): Promise<void>;
  request: {
    get(
      url: string,
      options: { timeout: number; maxRedirects: number },
    ): Promise<ViewerResponse & { dispose(): Promise<void> }>;
  };
}
interface ViewerBrowser {
  close(): Promise<void>;
  newContext(options: {
    viewport: { width: number; height: number };
    colorScheme: "light";
    acceptDownloads: boolean;
  }): Promise<ViewerContext>;
}
interface ViewerBrowserServer {
  close(): Promise<void>;
  kill(): Promise<void>;
  wsEndpoint(): string;
  once(event: "close", done: () => void): void;
}
export async function closeViewerBrowserSession(
  server: { close(): Promise<void> },
  context?: { close(): Promise<void> },
  browser?: { close(): Promise<void> },
) {
  try {
    await context?.close();
  } finally {
    try {
      await browser?.close();
    } finally {
      await server.close();
    }
  }
}
interface OwnedServer {
  ready: Promise<void>;
  close(): Promise<void>;
}

function childDrain(child: ChildProcess) {
  return new Promise<void>((done) => child.once("close", () => done()));
}
/** Fixed inline serving code, finite IPC only; no viewer credentials enter the child. */
function startOwnedServer(
  kind: "application" | "vite",
  environment: NodeJS.ProcessEnv,
  deadline: () => number,
): OwnedServer {
  const acquisition =
    kind === "application"
      ? `
    const require = createRequire(${JSON.stringify(resolve(root, "apps/api/package.json"))});
    require("reflect-metadata");
    const { createUsDevelopmentApplication } = require(${JSON.stringify(resolve(root, "apps/api/dist/deployment/us-bootstrap.js"))});
    resource = await createUsDevelopmentApplication(process.env);
  `
      : `
    const require = createRequire(${JSON.stringify(resolve(root, "apps/admin/package.json"))});
    const { createServer } = await import(require.resolve("vite"));
    const { createUsAdminConfig } = await import(${JSON.stringify(pathToFileURL(resolve(root, "apps/admin/vite.us.config.ts")).href)});
    resource = await createServer({ ...createUsAdminConfig({ VITE_DEPLOYMENT_EDITION: "US" }, "test"), configFile: false, mode: "test", logLevel: "silent" });
  `;
  const source = `
    import { createRequire } from "node:module";
    let resource, stopped = false, closing;
    const send = (value) => { if (process.connected) process.send(value, () => {}); };
    const close = () => closing ??= (async () => {
      if (!resource) return;
      try { await resource.close(); send("closed"); process.disconnect(); }
      catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
    })();
    const stop = () => { stopped = true; if (resource) void close(); };
    process.on("message", (value) => { if (value === "stop") stop(); });
    process.on("disconnect", stop);
    try {
      ${acquisition}
      if (stopped) await close();
      else {
        await resource.listen(${kind === "application" ? '3100, "127.0.0.1"' : ""});
        if (stopped) await close(); else send("ready");
      }
    } catch { process.exitCode = 1; stopped = true; if (resource) await close(); else if (process.connected) process.disconnect(); }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const drained = childDrain(child);
  let failed = false,
    normalClosed = false;
  const ready = new Promise<void>((done, reject) => {
    child.on("message", (message) => {
      if (message === "ready") done();
      else if (message === "closed") normalClosed = true;
      else {
        failed = true;
        reject(viewerBrowserFailure(kind));
      }
    });
    child.once("error", () => {
      failed = true;
      reject(viewerBrowserFailure(kind));
    });
    child.once("close", (code) => {
      if (code !== 0) failed = true;
      reject(viewerBrowserFailure(kind));
    });
  });
  void ready.catch(() => {});
  const stop = viewerOwnedShutdown(
    {
      normal: () => {
        if (child.connected)
          child.send("stop", (error) => {
            if (error) failed = true;
          });
      },
      terminate: () => {
        child.kill("SIGTERM");
      },
      kill: () => {
        child.kill("SIGKILL");
      },
      drained,
    },
    deadline,
  );
  let closing: Promise<void> | undefined;
  return {
    ready,
    close: () =>
      (closing ??= (async () => {
        await stop();
        if (failed || !normalClosed) throw viewerBrowserFailure("disposal");
      })()),
  };
}
interface Installation extends ReturnType<typeof createDb> {
  identity: { tenantId: string; userId: string };
  environment: NodeJS.ProcessEnv;
  observer: { counts(): { reads: number; mutations: number; failures: number; active: number } };
  snapshot(): Promise<Record<string, string>>;
  command(
    mode: "initialize",
  ): Promise<{ summary: unknown; elapsedMs: number; maximumRssKiB: number }>;
  close(): Promise<void>;
}

const viewerResult = z
  .object({
    status: z.literal("created"),
    tenantId: z.uuid(),
    viewerUserId: z.uuid(),
    email: z.literal("viewer@us-development.example.test"),
    role: z.literal("traceability_auditor"),
    synthetic: z.literal(true),
    mfaRequired: z.literal(true),
  })
  .strict();
/** Actual compiled process; bounded private stdin and closed diagnostics, never a shell. */
async function provision(
  installation: Installation,
  password: string,
  cap: number,
  register: (close: () => Promise<void>) => void,
  deadline: () => number,
) {
  const child = spawn(
    process.execPath,
    [
      resolve(root, "apps/api/dist/main.us-viewer.js"),
      "provision",
      "--tenant-id",
      installation.identity.tenantId,
      "--owner-id",
      installation.identity.userId,
      "--confirm-local-synthetic-viewer",
    ],
    { cwd: root, env: installation.environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  const drained = childDrain(child);
  register(
    viewerOwnedShutdown(
      {
        normal: () => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        },
        terminate: () => {
          child.kill("SIGTERM");
        },
        kill: () => {
          child.kill("SIGKILL");
        },
        drained,
      },
      deadline,
    ),
  );
  let stdout = Buffer.alloc(0),
    count = 0,
    failed = false;
  const stop = () => {
    failed = true;
    child.kill("SIGTERM");
  };
  const timer = setTimeout(stop, Math.max(1, cap - 1000));
  const kill = setTimeout(() => {
    failed = true;
    child.kill("SIGKILL");
  }, cap);
  child.on("error", () => {
    failed = true;
  });
  child.stdin.on("error", stop);
  child.stdout.on("data", (bytes: Buffer) => {
    count += bytes.length;
    if (count > 4096) stop();
    else stdout = Buffer.concat([stdout, bytes]);
  });
  child.stderr.on("data", (bytes: Buffer) => {
    count += bytes.length;
    failed = true;
    if (count > 4096) stop();
  });
  child.stdin.end(`${password}\n`);
  const code = await new Promise<number | null>((done) => child.once("close", done));
  clearTimeout(timer);
  clearTimeout(kill);
  if (failed || code !== 0) throw viewerBrowserFailure("provision");
  const result = viewerResult.parse(JSON.parse(stdout.toString("utf8")) as unknown);
  if (
    result.tenantId !== installation.identity.tenantId ||
    result.viewerUserId === installation.identity.userId
  )
    throw viewerBrowserFailure("provision");
  return result;
}

/** No caller-selected identity/environment/root. The real Node entry guards again before acquisition. */
export async function startUsDemoViewerBrowserFixture() {
  if (
    process.env.CI !== "true" ||
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.GITHUB_JOB !== "demo_viewer_acceptance" ||
    process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
    process.platform !== "linux" ||
    process.env.US_TEST_DATABASE_URL !==
      "postgres://markiro_us:markiro-us-development-only@127.0.0.1:55432/markiro_us_dev" ||
    process.env.NODE_OPTIONS ||
    process.env.NODE_PATH ||
    process.env.DEBUG ||
    process.env.PWDEBUG
  )
    throw new Error("us_demo_viewer_ci_only");
  let installation: Installation | undefined, app: OwnedServer | undefined;
  let vite: OwnedServer | undefined;
  let browser: ViewerBrowser | undefined, context: ViewerContext | undefined;
  let browserOwner: (() => Promise<void>) | undefined,
    provisionOwner: (() => Promise<void>) | undefined;
  let plans: UsPlanArtifactStore | undefined, packages: UsRequestPackageArtifactStore | undefined;
  let closing: Promise<void> | undefined,
    phase: Phase = "installation";
  let disposalDeadline: number | undefined;
  const cleanupDeadline = () => (disposalDeadline ??= performance.now() + 60_000);
  const setup = new ViewerSetupDeadline(() => {
    void close().catch(() => {});
  });
  const setupStart = setup.startedAt;
  const remaining = () => setup.remaining();
  const close = () =>
    (closing ??= (async () => {
      cleanupDeadline();
      // Set the latch without recursively invoking close while its promise is being assigned.
      queueMicrotask(() => setup.stop());
      await disposeViewerBrowserResources(
        [
          {
            phase: "browser",
            dispose: async () => {
              await browserOwner?.();
            },
          },
          {
            phase: "vite",
            dispose: async () => {
              await vite?.close();
            },
          },
          {
            phase: "application",
            dispose: async () => {
              await app?.close();
            },
          },
          {
            phase: "application",
            dispose: async () => {
              await provisionOwner?.();
            },
          },
          { phase: "application", dispose: () => setup.drain() },
          {
            phase: "private-stores",
            dispose: () => {
              try {
                packages?.destroy();
              } finally {
                plans?.onModuleDestroy();
              }
            },
          },
          {
            phase: "installation",
            dispose: async () => {
              await installation?.close();
            },
          },
        ],
        cleanupDeadline(),
      );
    })());
  try {
    const supportPath = pathToFileURL(
      resolve(root, "tools/us-development/test/support/dataset-command-positive-fixture.mjs"),
    ).href;
    const support = (await setup.run("installation", () => import(supportPath))) as {
      createDemoViewerInstallationFixture(): Promise<Installation>;
    };
    installation = await setup.run(
      "installation",
      () => support.createDemoViewerInstallationFixture(),
      (late) => late.close(),
    );
    const owned = installation;
    phase = "initialize";
    const initializeStart = performance.now();
    const initialized = await setup.initialize(() => owned.command("initialize"));
    const initializeMs = performance.now() - initializeStart;
    if (initializeMs > 900_000) throw viewerBrowserFailure(phase);
    remaining();
    phase = "provision";
    const password = `Synthetic-${randomBytes(24).toString("hex")}`;
    const viewer = await setup.run("provision", () =>
      provision(
        owned,
        password,
        remaining(),
        (close) => {
          provisionOwner = close;
        },
        cleanupDeadline,
      ),
    );
    phase = "descriptors";
    const stages = (
      await setup.run("descriptors", () =>
        owned.pool.query<{ unit_key: string; stage: string; receipt: { result: unknown } }>(
          "SELECT unit_key,stage,receipt FROM traceability_demo_dataset_stages WHERE tenant_id=$1 ORDER BY unit_key,stage",
          [owned.identity.tenantId],
        ),
      )
    ).rows;
    assert.deepEqual(
      stages.map((s) => `${s.unit_key}:${s.stage}`),
      usSixMonthDefinition.units.flatMap((u) => u.stages.map((s) => `${u.key}:${s}`)).sort(),
    );
    const planResult = parseUsDatasetPlanResult(
      stages.find((s) => s.unit_key === "plan")?.receipt.result,
    );
    const history = (
      [
        ["corrected", "correction_0001", "amend_receiving", "amended", "2026-06-10"],
        ["orphan", "orphan_0001", "void_receiving", "void", "2026-08-10"],
      ] as const
    ).map(([key, unit, stage, status, eventDate]) => {
      const result = parseUsDatasetSpecialResult(
        stages.find((s) => s.unit_key === unit && s.stage === stage)?.receipt.result,
      );
      assert.ok(result.stage === "amend_receiving" || result.stage === "void_receiving");
      const record = result.stage === "amend_receiving" ? result.predecessor : result.voided.record;
      assert.equal(record.status, status);
      assert.equal(record.revision, 1);
      assert.equal(record.content.kind, "finalized");
      assert.ok(record.content.kind === "finalized");
      assert.equal(record.content.snapshot.dateReceived, eventDate);
      const expected: ViewerHistoryExpectation = {
        eventId: record.id,
        rootId: record.lifecycle.rootId,
        type: "receiving",
        eventNumber: record.eventNumber,
        revision: record.revision,
        previousRevisionId: record.lifecycle.previousRevisionId,
        nextRevisionId: record.lifecycle.supersededByEventId,
        status,
        eventDate,
      };
      return { key, expected };
    });
    const planRows = await setup.run("descriptors", () =>
      owned.db.select().from(schema.traceabilityPlanVersions),
    );
    assert.equal(planRows.length, 1);
    const planRow = planRows[0];
    if (!planRow) throw viewerBrowserFailure(phase);
    const plan = parseUsPlanPublishedRow(planRow);
    assert.equal(plan.id, planResult.plan.id);
    const requests: {
      result: ReturnType<typeof parseUsDatasetRequestResult>;
      publication: Awaited<ReturnType<typeof readUsRequestPublishedState>>;
      capture: ReturnType<typeof requireUsRequestPackageEvidence>["validationSnapshot"];
    }[] = [];
    for (const [key, chains] of [
      ["request_scenario_a", ["chain_0259"]],
      [
        "request_april",
        Array.from({ length: 12 }, (_, i) => `chain_${String(i).padStart(4, "0")}`),
      ],
      [
        "request_september",
        Array.from({ length: 12 }, (_, i) => `chain_${String(i + 208).padStart(4, "0")}`),
      ],
    ] as const) {
      const result = parseUsDatasetRequestResult(
        stages.find((s) => s.unit_key === key && s.stage === "package")?.receipt.result,
      );
      const publication = await setup.run("descriptors", () =>
        owned.db.transaction((tx) =>
          readUsRequestPublishedState(tx, owned.identity.tenantId, result.run.id),
        ),
      );
      const capture = requireUsRequestPackageEvidence(
        publication.run,
        owned.identity.tenantId,
      ).validationSnapshot;
      const events = (
        await setup.run("descriptors", () =>
          owned.pool.query(
            "SELECT DISTINCT e.id AS \"eventId\",e.revision,e.root_event_id AS \"rootEventId\",'match' AS reason FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_events e ON e.id=ids.id::uuid AND e.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation','shipping') ORDER BY e.id",
            [owned.identity.tenantId, chains],
          ),
        )
      ).rows;
      const lots = (
        await setup.run("descriptors", () =>
          owned.pool.query<{ id: string }>(
            "SELECT DISTINCT l.id FROM traceability_demo_dataset_stages s CROSS JOIN LATERAL jsonb_array_elements_text(s.receipt->'recordIds') ids(id) JOIN traceability_lots l ON l.id=ids.id::uuid AND l.tenant_id=s.tenant_id WHERE s.tenant_id=$1 AND s.unit_key=ANY($2) AND s.stage IN ('receiving','transformation') ORDER BY l.id",
            [owned.identity.tenantId, chains],
          ),
        )
      ).rows;
      assert.deepEqual(
        [...capture.selection.records].sort((a, b) => a.eventId.localeCompare(b.eventId)),
        events,
      );
      assert.deepEqual(
        capture.selection.lotIds,
        lots.map((row) => row.id),
      );
      assert.ok(
        capture.selection.records.length >= chains.length * 3 &&
          capture.selection.records.length < 500,
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify(publication.run.inputSnapshot)) < 16 * 1024 * 1024,
      );
      assert.equal(publication.run.status, "ready");
      assert.equal(publication.run.mode, "export_ready");
      assert.equal(publication.run.createdBy, owned.identity.userId);
      assert.deepEqual(result.plan, { id: plan.id, sha256: planResult.artifact.sha256 });
      assert.equal(canonicalExportDigest(publication.artifacts), result.artifactsDigest);
      assert.equal(
        canonicalExportDigest({
          ...publication,
          run: Object.fromEntries(
            Object.entries(publication.run).map(([key, value]) => [
              key,
              value instanceof Date ? value.toISOString() : value,
            ]),
          ),
        }),
        result.publicationDigest,
      );
      assert.deepEqual(
        publication.artifacts.map(({ objectKey, tenantId, runId, ...descriptor }) => {
          void objectKey;
          void tenantId;
          void runId;
          return descriptor;
        }),
        result.artifacts,
      );
      assert.equal(result.artifacts.length, 6);
      requests.push({ result, publication, capture });
    }
    assert.deepEqual(initialized.summary, {
      synthetic: true,
      state: "six_month_seed_stages_verified",
      datasetComplete: false,
      datasetId: planResult.datasetId,
      version: usSixMonthDefinition.version,
      definitionDigest: usSixMonthDefinition.digest,
      plan: { id: plan.id, sha256: planResult.artifact.sha256 },
      requests: requests.map(({ result }) => ({
        unitKey: result.unitKey,
        requestId: result.request.id,
        runId: result.run.id,
        inputDigest: result.run.inputDigest,
        artifacts: result.artifacts.map(({ id, sha256 }) => ({ id, sha256 })),
        artifactsDigest: result.artifactsDigest,
        publicationDigest: result.publicationDigest,
      })),
    });
    const census = (
      await setup.run("descriptors", () =>
        owned.pool.query(
          "WITH roots AS (SELECT tenant_id,current_event_id FROM receiving_event_roots UNION ALL SELECT tenant_id,current_event_id FROM transformation_event_roots UNION ALL SELECT tenant_id,current_event_id FROM shipping_event_roots) SELECT (SELECT count(*)::int FROM roots WHERE tenant_id=$1) roots,(SELECT count(*)::int FROM roots r JOIN traceability_events e ON e.tenant_id=r.tenant_id AND e.id=r.current_event_id WHERE r.tenant_id=$1 AND e.status='finalized') finalized,(SELECT count(*)::int FROM traceability_lots WHERE tenant_id=$1) lots,(SELECT count(DISTINCT b.id)::int FROM boxes b JOIN traceability_synthetic_case_origins o ON o.tenant_id=b.tenant_id AND o.box_id=b.id WHERE b.tenant_id=$1) boxes",
          [owned.identity.tenantId],
        ),
      )
    ).rows;
    assert.deepEqual(census, [{ roots: 964, finalized: 963, lots: 785, boxes: 15700 }]);
    const planConfig = loadUsPlanArtifactStorageConfig(owned.environment),
      packageConfig = loadUsRequestPackageArtifactStorageConfig(owned.environment);
    if (!planConfig || !packageConfig) throw viewerBrowserFailure("descriptors");
    remaining();
    plans = new UsPlanArtifactStore(planConfig);
    packages = new UsRequestPackageArtifactStore(packageConfig);
    const planStore = plans,
      packageStore = packages;
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
    const privateSnapshot = () =>
      viewerBrowserPhase("private-bytes", async () => {
        const before = owned.observer.counts();
        const values: Record<string, { byteSize: number; sha256: string }> = {};
        async function read(name: string, operation: () => Promise<Buffer>, destroy: () => void) {
          const timer = setTimeout(destroy, 5000),
            start = performance.now();
          try {
            const bytes = await operation();
            if (performance.now() - start > 5000) throw viewerBrowserFailure("private-bytes");
            values[name] = { byteSize: bytes.length, sha256: digest(bytes) };
          } finally {
            clearTimeout(timer);
          }
        }
        await read(
          "plan",
          () =>
            planStore.readVerified(
              { tenantId: owned.identity.tenantId, versionId: plan.id },
              plan.artifact,
            ),
          () => planStore.onModuleDestroy(),
        );
        for (const { publication, result } of requests)
          for (const artifact of publication.artifacts)
            await read(
              `${result.unitKey}/${artifact.kind}`,
              () =>
                packageStore.readVerified(
                  { tenantId: owned.identity.tenantId, runId: result.run.id },
                  artifact,
                ),
              () => packageStore.destroy(),
            );
        const after = owned.observer.counts();
        assert.equal(after.reads - before.reads, 19);
        assert.equal(after.mutations, before.mutations);
        assert.equal(after.failures, before.failures);
        assert.equal(after.active, 0);
        return { values, verificationReads: after.reads - before.reads };
      });
    const snapshot = () => viewerBrowserPhase("snapshot", () => owned.snapshot());
    const identitySnapshot = () =>
      viewerBrowserPhase("snapshot", async () => {
        const rows = await owned.pool.query(
          "SELECT row FROM (SELECT to_jsonb(u)-'updated_at'-'two_factor_enabled' AS row FROM \"user\" u WHERE id=$1 UNION ALL SELECT to_jsonb(u) AS row FROM \"user\" u WHERE id<>$1) users ORDER BY row::text",
          [viewer.viewerUserId],
        );
        return canonicalExportDigest(rows.rows);
      });
    const authFacts = () =>
      viewerBrowserPhase("snapshot", async () => {
        const result = await owned.pool.query<{
          users: number;
          accounts: number;
          sessions: number;
          verifications: number;
          factors: number;
          assurances: number;
          valid_session: boolean;
          valid_factor: boolean;
          valid_assurance: boolean;
          enabled: boolean;
        }>(
          'SELECT (SELECT count(*)::int FROM "user") users,(SELECT count(*)::int FROM account) accounts,(SELECT count(*)::int FROM session) sessions,(SELECT count(*)::int FROM verification) verifications,(SELECT count(*)::int FROM us_two_factors) factors,(SELECT count(*)::int FROM us_session_assurances) assurances,NOT EXISTS(SELECT 1 FROM session WHERE user_id<>$1 OR active_organization_id IS DISTINCT FROM $2 OR expires_at<=now()) valid_session,NOT EXISTS(SELECT 1 FROM us_two_factors WHERE user_id<>$1 OR NOT verified OR failed_verification_count<>0 OR locked_until IS NOT NULL) valid_factor,NOT EXISTS(SELECT 1 FROM us_session_assurances a LEFT JOIN session s ON s.id=a.session_id LEFT JOIN us_two_factors f ON f.id=a.factor_id WHERE s.user_id IS DISTINCT FROM $1 OR f.user_id IS DISTINCT FROM $1) valid_assurance,(SELECT two_factor_enabled FROM "user" WHERE id=$1) enabled',
          [viewer.viewerUserId, owned.identity.tenantId],
        );
        return result.rows[0];
      });
    const auditSnapshot = () =>
      viewerBrowserPhase("snapshot", () =>
        owned.db.select().from(schema.tenantAuditEvents).orderBy(schema.tenantAuditEvents.id),
      );
    phase = "ports";
    await setup.run("ports", () => requireViewerFreePort(3100, "127.0.0.1"));
    await setup.run("ports", () => requireViewerFreePort(5174, "localhost"));
    phase = "application";
    remaining();
    app = startOwnedServer("application", owned.environment, cleanupDeadline);
    await setup.run("application", () =>
      app ? app.ready : Promise.reject(viewerBrowserFailure("application")),
    );
    phase = "vite";
    remaining();
    vite = startOwnedServer("vite", process.env, cleanupDeadline);
    await setup.run("vite", () =>
      vite ? vite.ready : Promise.reject(viewerBrowserFailure("vite")),
    );
    phase = "browser";
    const browserRequire = createRequire(resolve(root, "tools/production-browser/package.json"));
    assert.equal(
      (browserRequire("@playwright/test/package.json") as { version: string }).version,
      "1.62.0",
    );
    const runtime = browserRequire("@playwright/test") as {
      chromium: {
        launchServer(options: {
          timeout: number;
          host: "127.0.0.1";
          port: 0;
        }): Promise<ViewerBrowserServer>;
        connect(endpoint: string, options: { timeout: number }): Promise<ViewerBrowser>;
      };
      expect: {
        configure(options: { timeout: number }): (locator: ViewerLocator) => ViewerAssertions;
      };
    };
    const ownServer = (server: ViewerBrowserServer) => {
      const drained = new Promise<void>((done) => server.once("close", done));
      return viewerOwnedShutdown(
        {
          // Connected Browser.close disconnects its client. This dependent normal sequence
          // does not block the independent exact-server cancellation timers.
          normal: () => closeViewerBrowserSession(server, context, browser),
          terminate: () => server.kill(),
          kill: () => server.kill(),
          drained,
        },
        cleanupDeadline,
      );
    };
    const server = await setup.run(
      "browser",
      () =>
        runtime.chromium.launchServer({
          timeout: Math.min(5000, remaining()),
          host: "127.0.0.1",
          port: 0,
        }),
      (late) => ownServer(late)(),
    );
    browserOwner = ownServer(server);
    browser = await setup.run(
      "browser",
      () => runtime.chromium.connect(server.wsEndpoint(), { timeout: Math.min(5000, remaining()) }),
      (late) => late.close(),
    );
    const ownedBrowser = browser;
    context = await setup.run(
      "browser",
      () =>
        ownedBrowser.newContext({
          viewport: { width: 1440, height: 900 },
          colorScheme: "light",
          acceptDownloads: true,
        }),
      (late) => late.close(),
    );
    const ownedContext = context;
    const page = await setup.run(
      "browser",
      () => ownedContext.newPage(),
      (late) => late.close(),
    );
    page.setDefaultTimeout(5000);
    setup.finish();
    return {
      origin: "http://localhost:5174",
      page,
      context,
      webExpect: runtime.expect.configure({ timeout: 5000 }),
      password,
      viewerUserId: viewer.viewerUserId,
      tenantId: owned.identity.tenantId,
      ownerUserId: owned.identity.userId,
      plan,
      planResult,
      requests,
      history,
      snapshot,
      identitySnapshot,
      authFacts,
      auditSnapshot,
      privateSnapshot,
      providerSnapshot: () => owned.observer.counts(),
      measurements: {
        initializeMs,
        maximumRssKiB: initialized.maximumRssKiB,
        setupMs: performance.now() - setupStart - initializeMs,
      },
      close,
    };
  } catch {
    try {
      await close();
    } catch {
      throw new Error(
        `Viewer browser failed: ${phase}; disposal incomplete: pending-setup=${setup.pendingCount()}`,
      );
    }
    throw viewerBrowserFailure(phase);
  }
}
export type UsDemoViewerBrowserFixture = Awaited<
  ReturnType<typeof startUsDemoViewerBrowserFixture>
>;
