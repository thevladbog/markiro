# SaaS Production Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build, publish, and continuously smoke-test a digest-pinned production bundle for the Markiro API and admin edge, with runtime migrations, bounded readiness, and an operator-safe deploy/rollback path.

**Architecture:** A compiled runtime migrator and the Nest API share one pinned Node image; a separately pinned Caddy image contains the built admin SPA and owns the public TLS endpoint. Production Compose contains only `migrate`, `api`, and `edge`, while a CI overlay supplies PostgreSQL, Mailpit, and MinIO to exercise the exact production images and routes.

**Tech Stack:** Node.js 24.19.0, Corepack pnpm 11.10.0, NestJS 11, Drizzle ORM 0.45.2, PostgreSQL 17, Docker Compose, Caddy 2.11.4, GitHub Actions, Node test runner

## Global Constraints

- Use exact builder base `node:24.19.0-bookworm-slim` and exact edge runtime `caddy:2.11.4-alpine`; do not use floating `latest` tags.
- The 40-character `MARKIRO_IMAGE_TAG` is release identity only. GHCR SHA tags are mutable selectors. Production images are selected by preapproved repository digests: `ghcr.io/thevladbog/markiro-api@${MARKIRO_API_IMAGE_DIGEST}` and `ghcr.io/thevladbog/markiro-edge@${MARKIRO_EDGE_IMAGE_DIGEST}`, with strict lowercase `sha256:` plus 64-hex inputs from trusted Actions evidence.
- The one-API/one-edge Compose identity does not guarantee zero downtime: candidate recreation can make the old edge unavailable, and rollback recreates the previous digest pair. A separately addressable blue/green topology is the next slice, not part of this plan.
- Run production containers as unprivileged users with read-only root filesystems, dropped Linux capabilities, `no-new-privileges`, and a bounded `/tmp` tmpfs.
- Keep the API on the private Compose network; only `edge` may publish host ports 80 and 443 in the production defaults.
- Keep PostgreSQL, SMTP, and S3 external to `compose.production.yml`; local substitutes are allowed only in `deploy/production/compose.ci.yml`.
- Preserve `/api/auth/*` exactly, strip one `/api` prefix for other admin calls, preserve every station, kiosk, 1C, health, docs, and OpenAPI path, and never route an unknown non-GET request to the SPA.
- Preserve the exact CSP from the approved design and do not add external script, style, font, image, or connection origins.
- Do not install or execute `drizzle-kit` in production; migrations use the compiled Drizzle ORM runtime migrator under a fixed PostgreSQL advisory lock.
- The `migrate` service uses the exact same digest-pinned API image as `api`. If migration fails before service replacement, `api` and `edge` containers are not switched, but the migrator may already have committed a prefix of forward migrations to the shared database. Treat that database as changed: the compatibility and rollback gate still applies.
- Keep `GET /health` as the liveness compatibility alias; required PostgreSQL or pg-boss failure makes `/health/ready` return 503, while SMTP or S3 failure returns a 200 degraded report.
- Probe timeouts are 2,000 ms, successful and failed probe results are cached for 10,000 ms, and raw provider errors, endpoints, and credentials never appear in responses or logs.
- Do not add a generic request-body limit at Caddy because `/1c_exchange` accepts large CommerceML uploads.
- Do not add a third-party Caddy rate-limit module; public go-live remains gated on a cloud/WAF edge limit or a separately reviewed custom image.
- Never print `docker compose config` without `--quiet`, never commit `.env.production`, and require environment-file mode 0600.
- Every database migration in this release must remain backward-compatible with the immediately previous API image; rollback changes images, never reverses migrations.

---

## File map

- `apps/api/src/health.controller.ts` — HTTP liveness/readiness surface and status code selection.
- `apps/api/src/health/readiness.service.ts` — cached, bounded component probes and stable response types.
- `apps/api/src/app.module.ts` — production dependency adapters for readiness.
- `apps/api/src/jobs/jobs.module.ts` — pg-boss lifecycle readiness state.
- `packages/db/src/runtime-migrate.ts` — advisory-lock migration library with injectable boundaries.
- `packages/db/src/migrate-cli.ts` — production CLI entrypoint that reads only `DATABASE_URL`.
- `deploy/production/api.Dockerfile` — production-only API closure shared by `migrate` and `api`.
- `deploy/production/healthcheck.mjs` — dependency-free container health command.
- `deploy/production/edge.Dockerfile` — admin builder and minimal Caddy runtime.
- `deploy/production/Caddyfile` — ordered route, SPA, cache, compression, and security-header policy.
- `compose.production.yml` — three-service production topology and hardening contract.
- `deploy/production/compose.ci.yml` — CI-only PostgreSQL, Mailpit, MinIO, and test port overlay.
- `deploy/production/preflight.mjs` — release-SHA, image-digest, hostname, email, secret-file-mode, and Compose validation.
- `deploy/production/deploy.mjs` — pull, digest record, migrate, API readiness gate, and edge switch orchestration.
- `deploy/production/smoke.mjs` — route/header/runtime/shutdown checks against the built bundle.
- `deploy/production/test/*.test.mjs` — dependency-free contract and orchestration tests.
- `.github/workflows/ci.yml` — production-bundle build and smoke gate.
- `.github/workflows/release-images.yml` — main-branch SHA-tag GHCR publication with validated digest evidence.
- `.env.production.example` — complete key inventory with blank values only.
- `docs/runbooks/saas-production-deploy.md` — backup, deploy, smoke, rollback, and go-live gate.

### Task 1: Bounded production readiness

**Files:**

- Create: `apps/api/src/health/readiness.service.ts`
- Modify: `apps/api/src/health.controller.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/jobs/jobs.module.ts`
- Modify: `apps/api/test/health.e2e.test.ts`
- Create: `apps/api/test/readiness.service.test.ts`

**Interfaces:**

- Consumes: `DB_POOL` with `query("SELECT 1")`; `PgBossService.checkReady(): Promise<void>`; `MailTransportService.verify(): Promise<boolean>` and `.health`; `ObjectStorageService.ensureBucket(): Promise<void>`.
- Produces: `ReadinessService.ready(): Promise<ReadinessReport>`, `ReadinessService.live(): LiveReport`, `PgBossService.checkReady(): Promise<void>`, and HTTP `GET /health`, `/health/live`, `/health/ready`.

- [ ] **Step 1: Write failing readiness-service tests**

Create `apps/api/test/readiness.service.test.ts` with fake dependency functions and a fake clock. Assert these exact cases:

```ts
import { describe, expect, it, vi } from "vitest";
import { ReadinessService } from "../src/health/readiness.service";

const NOW = new Date("2026-08-04T09:00:00.000Z");

function healthyDependencies() {
  return {
    database: vi.fn<() => Promise<void>>(async () => undefined),
    jobs: vi.fn<() => Promise<void>>(async () => undefined),
    smtp: vi.fn<() => Promise<{ status: "healthy" | "degraded" | "unknown" }>>(async () => ({
      status: "healthy",
    })),
    storage: vi.fn<() => Promise<void>>(async () => undefined),
    now: vi.fn<() => Date>(() => NOW),
  };
}

describe("ReadinessService", () => {
  it("reports every healthy dependency without provider details", async () => {
    const service = new ReadinessService(healthyDependencies());
    await expect(service.ready()).resolves.toEqual({
      status: "ok",
      checkedAt: NOW.toISOString(),
      checks: {
        database: { status: "healthy", checkedAt: NOW.toISOString() },
        jobs: { status: "healthy", checkedAt: NOW.toISOString() },
        smtp: { status: "healthy", checkedAt: NOW.toISOString() },
        storage: { status: "healthy", checkedAt: NOW.toISOString() },
      },
    });
  });

  it("marks a required database failure unavailable and sanitizes the error", async () => {
    const dependencies = healthyDependencies();
    dependencies.database.mockRejectedValue(
      new Error("password=secret postgres://user:secret@database.internal/markiro"),
    );
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("unavailable");
    expect(report.checks.database).toEqual({
      status: "unavailable",
      category: "database_unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(JSON.stringify(report)).not.toMatch(/secret|database\.internal|postgres:\/\//);
  });

  it("marks a pg-boss probe failure unavailable", async () => {
    const dependencies = healthyDependencies();
    dependencies.jobs.mockRejectedValue(new Error("pg-boss connection lost"));
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("unavailable");
    expect(report.checks.jobs).toEqual({
      status: "unavailable",
      category: "jobs_unavailable",
      checkedAt: NOW.toISOString(),
    });
  });

  it("keeps SMTP and S3 failures degraded rather than unavailable", async () => {
    const dependencies = healthyDependencies();
    dependencies.smtp.mockResolvedValue({ status: "degraded" });
    dependencies.storage.mockRejectedValue(new Error("AccessDenied: private detail"));
    const report = await new ReadinessService(dependencies).ready();
    expect(report.status).toBe("degraded");
    expect(report.checks.smtp).toEqual({
      status: "degraded",
      category: "smtp_unavailable",
      checkedAt: NOW.toISOString(),
    });
    expect(report.checks.storage).toEqual({
      status: "degraded",
      category: "storage_unavailable",
      checkedAt: NOW.toISOString(),
    });
  });

  it("coalesces concurrent calls and caches the report for ten seconds", async () => {
    const dependencies = healthyDependencies();
    const service = new ReadinessService(dependencies);
    await Promise.all([service.ready(), service.ready()]);
    await service.ready();
    expect(dependencies.database).toHaveBeenCalledTimes(1);
    expect(dependencies.smtp).toHaveBeenCalledTimes(1);
    expect(dependencies.storage).toHaveBeenCalledTimes(1);
  });

  it("bounds a hanging probe at two seconds", async () => {
    vi.useFakeTimers();
    const dependencies = healthyDependencies();
    dependencies.database.mockImplementation(() => new Promise(() => undefined));
    const result = new ReadinessService(dependencies).ready();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({
      status: "unavailable",
      checks: { database: { category: "database_timeout" } },
    });
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/readiness.service.test.ts`

Expected: FAIL because `../src/health/readiness.service` does not exist.

- [ ] **Step 3: Implement stable report types, timeouts, in-flight coalescing, and caching**

Create `apps/api/src/health/readiness.service.ts` with:

```ts
export const PROBE_TIMEOUT_MS = 2_000;
export const PROBE_CACHE_MS = 10_000;

export type ComponentStatus = "healthy" | "degraded" | "unavailable";
export type ComponentReport = {
  status: ComponentStatus;
  checkedAt: string;
  category?:
    | "database_unavailable"
    | "database_timeout"
    | "jobs_unavailable"
    | "jobs_timeout"
    | "smtp_unavailable"
    | "smtp_timeout"
    | "storage_unavailable"
    | "storage_timeout";
};
export type ReadinessReport = {
  status: "ok" | "degraded" | "unavailable";
  checkedAt: string;
  checks: Record<"database" | "jobs" | "smtp" | "storage", ComponentReport>;
};
export type LiveReport = { status: "ok" };

export type ReadinessDependencies = {
  database(): Promise<void>;
  jobs(): Promise<void>;
  smtp(): Promise<{ status: "healthy" | "degraded" | "unknown" }>;
  storage(): Promise<void>;
  now(): Date;
};

export class ReadinessService {
  private cached?: { expiresAt: number; report: ReadinessReport };
  private inFlight?: Promise<ReadinessReport>;

  constructor(private readonly dependencies: ReadinessDependencies) {}

  live(): LiveReport {
    return { status: "ok" };
  }

  ready(): Promise<ReadinessReport> {
    const now = this.dependencies.now().getTime();
    if (this.cached && now < this.cached.expiresAt) return Promise.resolve(this.cached.report);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.probe()
      .then((report) => {
        this.cached = { expiresAt: this.dependencies.now().getTime() + PROBE_CACHE_MS, report };
        return report;
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  private async probe(): Promise<ReadinessReport> {
    const checkedAt = this.dependencies.now().toISOString();
    const [database, jobs, smtp, storage] = await Promise.all([
      this.bounded(
        this.dependencies.database,
        checkedAt,
        "unavailable",
        "database_unavailable",
        "database_timeout",
      ),
      this.bounded(
        this.dependencies.jobs,
        checkedAt,
        "unavailable",
        "jobs_unavailable",
        "jobs_timeout",
      ),
      this.bounded(
        async () => {
          const result = await this.dependencies.smtp();
          if (result.status !== "healthy") throw new Error("smtp degraded");
        },
        checkedAt,
        "degraded",
        "smtp_unavailable",
        "smtp_timeout",
      ),
      this.bounded(
        this.dependencies.storage,
        checkedAt,
        "degraded",
        "storage_unavailable",
        "storage_timeout",
      ),
    ]);
    const status =
      database.status === "unavailable" || jobs.status === "unavailable"
        ? "unavailable"
        : smtp.status === "degraded" || storage.status === "degraded"
          ? "degraded"
          : "ok";
    return { status, checkedAt, checks: { database, jobs, smtp, storage } };
  }

  private async bounded(
    run: () => Promise<void>,
    checkedAt: string,
    failureStatus: "degraded" | "unavailable",
    failureCategory: NonNullable<ComponentReport["category"]>,
    timeoutCategory: NonNullable<ComponentReport["category"]>,
  ): Promise<ComponentReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ProbeTimeout()), PROBE_TIMEOUT_MS);
        }),
      ]);
      return { status: "healthy", checkedAt };
    } catch (error) {
      return {
        status: failureStatus,
        category: error instanceof ProbeTimeout ? timeoutCategory : failureCategory,
        checkedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

class ProbeTimeout extends Error {}
```

- [ ] **Step 4: Add pg-boss lifecycle state**

In `PgBossService`, add `private started = false`, set it only after every queue, worker, schedule, and immediate maintenance path finishes, and clear it both in the catch block and before `boss.stop()`. Expose this active check:

```ts
async checkReady(): Promise<void> {
  if (!this.started || !this.boss) throw new Error("pg-boss is not started");
  await this.boss.getDb().executeSql("SELECT 1");
}
```

Export `PgBossService` from `JobsModule` so the root dynamic module can inject it.

- [ ] **Step 5: Wire production dependencies and HTTP semantics**

Change base `@Module` metadata on `AppModule` to empty metadata and register `HealthController` plus `ReadinessService` only from `forRoot()`. The factory must inject `DB_POOL`, `PgBossService`, `MailTransportService`, and `ObjectStorageService` and supply exactly:

```ts
new ReadinessService({
  database: async () => {
    await pool.query("SELECT 1");
  },
  jobs: async () => {
    await jobs.checkReady();
  },
  smtp: async () => {
    await mail.verify();
    return { status: mail.health.status };
  },
  storage: async () => {
    await storage.ensureBucket();
  },
  now: () => new Date(),
});
```

Update `HealthController` to inject `ReadinessService`; make `/health` and `/health/live` return `service.live()`, and make `/health/ready` set `response.status(503)` only when `report.status === "unavailable"`, otherwise 200. Use `@Res({ passthrough: true })` so Nest still serializes the report.

- [ ] **Step 6: Replace the health e2e test with exact route/status assertions**

Build a test module with `HealthController` and a fake `ReadinessService`, rather than importing the now-production-only `AppModule`. Assert:

```ts
await request(server).get("/health").expect(200, { status: "ok" });
await request(server).get("/health/live").expect(200, { status: "ok" });
await request(server).get("/health/ready").expect(503);
```

The fake ready report must use stable categories only, and the 503 body must equal that report exactly.

- [ ] **Step 7: Run focused and package checks**

Run: `corepack pnpm --filter @markiro/api exec vitest run test/readiness.service.test.ts test/health.e2e.test.ts`

Expected: all tests PASS.

Run: `corepack pnpm turbo lint typecheck --filter @markiro/api...`

Expected: PASS with no new warnings.

- [ ] **Step 8: Commit the readiness slice**

```bash
git add apps/api/src/health apps/api/src/health.controller.ts apps/api/src/app.module.ts apps/api/src/jobs/jobs.module.ts apps/api/test/health.e2e.test.ts apps/api/test/readiness.service.test.ts
git commit -m "feat: add bounded production readiness"
```

### Task 2: Runtime database migrator

**Files:**

- Create: `packages/db/src/runtime-migrate.ts`
- Create: `packages/db/src/migrate-cli.ts`
- Create: `packages/db/test/runtime-migrate.test.ts`
- Modify: `packages/db/package.json`

**Interfaces:**

- Consumes: `DATABASE_URL`; `packages/db/migrations/meta/_journal.json`; Drizzle `migrate(db, { migrationsFolder })`; PostgreSQL session advisory locks.
- Produces: `runRuntimeMigrations(options: RuntimeMigrationOptions): Promise<RuntimeMigrationResult>` and executable `node node_modules/@markiro/db/dist/migrate-cli.js`.

- [ ] **Step 1: Write failing unit tests around injected database boundaries**

Create `packages/db/test/runtime-migrate.test.ts`. Inject a fake pool/client, fake migration function, journal reader, and log sink. Assert this exact call order on success:

```ts
[
  ["connect"],
  ["query", "SELECT pg_advisory_lock($1, $2)", [1296126539, 1230131023]],
  ["migrate", "/bundle/migrations"],
  ["query", "SELECT pg_advisory_unlock($1, $2)", [1296126539, 1230131023]],
  ["release"],
  ["pool.end"],
];
```

Add separate tests proving that:

- unlock, client release, and pool close still occur when migration throws;
- journal tags are logged as `migration packaged: 0028_avatar-owner-integrity` without SQL content;
- neither a success nor a failure log contains the supplied URL `postgres://user:secret@db.internal/markiro`;
- an empty `DATABASE_URL` is rejected before pool construction.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `corepack pnpm --filter @markiro/db exec vitest run test/runtime-migrate.test.ts`

Expected: FAIL because `runtime-migrate.ts` does not exist.

- [ ] **Step 3: Implement the lock-safe migration library**

Define these exact public types in `runtime-migrate.ts`:

```ts
export type RuntimeMigrationResult = {
  packaged: readonly string[];
  completedAt: string;
};

export type RuntimeMigrationOptions = {
  databaseUrl: string;
  migrationsFolder: string;
  log?: (message: string) => void;
  now?: () => Date;
};

export async function runRuntimeMigrations(
  options: RuntimeMigrationOptions,
): Promise<RuntimeMigrationResult>;
```

Use `pg.Pool`, `drizzle(pool)`, and `migrate()` from `drizzle-orm/node-postgres/migrator`. Read `meta/_journal.json`, validate entries as objects with non-empty string `tag` fields, and log only tags plus the stable start/completion/failure phrases. Hold the two-key advisory lock on one checked-out `PoolClient` for the entire `migrate()` call. In nested `finally` blocks, attempt unlock, always release the client, and always close the pool. If migration and unlock both fail, preserve the migration error as the thrown error and log only `runtime migration failed`.

- [ ] **Step 4: Add the production CLI**

Create `migrate-cli.ts` with this boundary:

```ts
import { fileURLToPath } from "node:url";
import { runRuntimeMigrations } from "./runtime-migrate.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

runRuntimeMigrations({ databaseUrl, migrationsFolder })
  .then(() => {
    process.exitCode = 0;
  })
  .catch(() => {
    process.exitCode = 1;
  });
```

Do not print the caught error. Export `runRuntimeMigrations` and its types only through the explicit server-only `@markiro/db/runtime-migrate` package subpath; do not re-export them from `src/index.ts`, because browser clients consume the root barrel. Add `"db:migrate:runtime": "node dist/migrate-cli.js"` to `packages/db/package.json`; do not change the development `db:migrate` script.

- [ ] **Step 5: Verify unit behavior and compiled artifact layout**

Run: `corepack pnpm --filter @markiro/db exec vitest run test/runtime-migrate.test.ts`

Expected: PASS.

Run: `corepack pnpm --filter @markiro/db build`

Expected: PASS and both `packages/db/dist/runtime-migrate.js` and `packages/db/dist/migrate-cli.js` exist.

Run with `DATABASE_URL` unset: `env -u DATABASE_URL node packages/db/dist/migrate-cli.js`

Expected: exit code 1 and output contains no URL, password, or raw provider error.

- [ ] **Step 6: Prove replay safety against the configured PostgreSQL**

Run twice:

```bash
DATABASE_URL="$DATABASE_URL" corepack pnpm --filter @markiro/db db:migrate:runtime
DATABASE_URL="$DATABASE_URL" corepack pnpm --filter @markiro/db db:migrate:runtime
```

Expected: both commands exit 0; the second creates no duplicate objects and logs only packaged identifiers and stable status lines.

- [ ] **Step 7: Commit the migrator**

```bash
git add packages/db/package.json packages/db/src/runtime-migrate.ts packages/db/src/migrate-cli.ts packages/db/test/runtime-migrate.test.ts
git commit -m "feat: add runtime database migrator"
```

### Task 3: Minimal, hardened API image

**Files:**

- Create: `.dockerignore`
- Create: `deploy/production/api.Dockerfile`
- Create: `deploy/production/healthcheck.mjs`
- Create: `deploy/production/test/api-image-contract.test.mjs`
- Create: `deploy/production/test/healthcheck.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: compiled `@markiro/api...`, `@markiro/db/dist/migrate-cli.js`, `packages/db/migrations`, production dependencies from `pnpm deploy --legacy --prod`.
- Produces: API image whose default command is `node dist/main.js`, whose migration command is `node node_modules/@markiro/db/dist/migrate-cli.js`, and whose health command is `node /opt/markiro/healthcheck.mjs`.

- [ ] **Step 1: Add failing Dockerfile and health-script contract tests**

Create `api-image-contract.test.mjs` with Node's `node:test`. Read the Dockerfile as text and assert all of the following:

```js
assert.match(source, /FROM node:24\.19\.0-bookworm-slim AS build/);
assert.match(source, /corepack prepare pnpm@11\.10\.0 --activate/);
assert.match(source, /pnpm install --frozen-lockfile/);
assert.match(source, /turbo build --filter @markiro\/api\.\.\./);
assert.match(source, /pnpm --filter @markiro\/api deploy --legacy --prod \/out\/api/);
assert.match(source, /FROM node:24\.19\.0-bookworm-slim AS runtime/);
assert.match(source, /apt-get install[^\n]*tini/);
assert.match(source, /COPY --from=build \/out\/api \/app/);
assert.match(
  source,
  /COPY --from=build \/workspace\/packages\/db\/migrations \/app\/node_modules\/@markiro\/db\/migrations/,
);
assert.match(source, /USER node/);
assert.match(source, /ENTRYPOINT \["\/usr\/bin\/tini", "--"\]/);
assert.match(source, /CMD \["node", "dist\/main\.js"\]/);
assert.doesNotMatch(source, /drizzle-kit|pnpm install[^\n]*--prod/);
```

Also assert `.dockerignore` excludes `.git`, `.worktrees`, `node_modules`, every `dist`, `.env`, `.pnpm-store`, `.turbo`, coverage, and local release records while explicitly allowing source, package manifests, lockfile, migrations, patches, and config files needed by the build.

Create `healthcheck.test.mjs`; start a loopback Node HTTP server and spawn the script with `HEALTHCHECK_URL` pointed at it. Assert exit 0 only for HTTP 200 with JSON status `ok` or `degraded`; assert exit 1 for `unavailable`, non-JSON, HTTP 503, connection refusal, and a response delayed past 2,000 ms. Assert stdout/stderr are empty in every case.

- [ ] **Step 2: Run the contract tests and verify RED**

Run: `node --test deploy/production/test/api-image-contract.test.mjs deploy/production/test/healthcheck.test.mjs`

Expected: FAIL because the Dockerfile and healthcheck script do not exist.

- [ ] **Step 3: Implement the dependency-free health command**

Create `healthcheck.mjs` using only global `fetch`, `AbortSignal.timeout(2_000)`, and `JSON.parse` through `response.json()`. Default the URL to `http://127.0.0.1:3000/health/ready`. Set `process.exitCode = 0` only when `response.ok` and the parsed `status` is `ok` or `degraded`; catch every error and set exit 1 without logging it.

- [ ] **Step 4: Implement the two-stage API Dockerfile**

Use this stage contract:

```dockerfile
FROM node:24.19.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY patches ./patches
COPY apps/api/package.json ./apps/api/package.json
COPY packages/db/package.json ./packages/db/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/email/package.json ./packages/email/package.json
RUN pnpm install --frozen-lockfile
COPY apps/api ./apps/api
COPY packages/db ./packages/db
COPY packages/domain ./packages/domain
COPY packages/email ./packages/email
RUN pnpm turbo build --filter @markiro/api...
RUN pnpm --filter @markiro/api deploy --legacy --prod /out/api

FROM node:24.19.0-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install --no-install-recommends -y tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /workspace/packages/db/migrations /app/node_modules/@markiro/db/migrations
COPY --chown=node:node deploy/production/healthcheck.mjs /opt/markiro/healthcheck.mjs
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
```

If `pnpm deploy --legacy --prod` omits a workspace package's built `dist`, first prove the omission by inspecting each of `/out/api/node_modules/@markiro/db`, `/out/api/node_modules/@markiro/domain`, and `/out/api/node_modules/@markiro/email`; then add `"files": ["dist"]` only to the package whose output is absent. Do not copy the entire workspace into the runtime stage.

- [ ] **Step 5: Add a root contract-test script and make tests GREEN**

Add:

```json
"test:production-bundle:contract": "node --test deploy/production/test/*.test.mjs"
```

Run: `corepack pnpm test:production-bundle:contract`

Expected: PASS.

- [ ] **Step 6: Build and inspect the real image**

Run:

```bash
docker build --file deploy/production/api.Dockerfile --tag markiro-api:test .
docker image inspect markiro-api:test --format '{{json .Config.User}} {{json .Config.Entrypoint}} {{json .Config.Cmd}}'
docker run --rm --entrypoint node markiro-api:test -e "import('@markiro/db').then(() => process.exit(0))"
docker run --rm --entrypoint test markiro-api:test -f /app/node_modules/@markiro/db/dist/migrate-cli.js
docker run --rm --entrypoint test markiro-api:test -f /app/node_modules/@markiro/db/migrations/meta/_journal.json
```

Expected: build succeeds; inspect prints user `node`, `tini --`, and `node dist/main.js`; all three runtime probes exit 0. The image contains no `drizzle-kit` executable and no application source `.ts` files outside dependency declaration files.

- [ ] **Step 7: Commit the API image**

```bash
git add .dockerignore package.json deploy/production/api.Dockerfile deploy/production/healthcheck.mjs deploy/production/test/api-image-contract.test.mjs deploy/production/test/healthcheck.test.mjs
git commit -m "build: add hardened API image"
```

### Task 4: Admin edge image and exact public routing

**Files:**

- Create: `deploy/production/edge.Dockerfile`
- Create: `deploy/production/Caddyfile`
- Create: `deploy/production/test/edge-contract.test.mjs`

**Interfaces:**

- Consumes: `apps/admin/dist`; private upstream `api:3000`; `MARKIRO_DOMAIN`; `ACME_EMAIL`.
- Produces: Caddy edge image serving the SPA and proxying the approved path contract.

- [ ] **Step 1: Write the failing edge contract test**

Create `edge-contract.test.mjs` and assert:

```js
const caddy = await readFile("deploy/production/Caddyfile", "utf8");
const dockerfile = await readFile("deploy/production/edge.Dockerfile", "utf8");

assert.match(dockerfile, /FROM node:24\.19\.0-bookworm-slim AS build/);
assert.match(dockerfile, /FROM caddy:2\.11\.4-alpine AS runtime/);
assert.match(dockerfile, /turbo build --filter @markiro\/admin\.\.\./);
assert.match(dockerfile, /COPY --from=build \/workspace\/apps\/admin\/dist \/srv/);
assert.match(dockerfile, /addgroup -S -g 10001 markiro/);
assert.match(dockerfile, /setcap -r \/usr\/bin\/caddy/);
assert.match(dockerfile, /USER 10001:10001/);
assert.doesNotMatch(
  dockerfile.split("FROM caddy:2.11.4-alpine AS runtime")[1],
  /node|pnpm|workspace\/apps/,
);

const ordered = [
  "@apiAuth path /api/auth/*",
  "handle @apiAuth",
  "handle_path /api/*",
  "@device path /station/* /kiosk/* /1c_exchange /health* /openapi.json /docs*",
  "handle @device",
  "@assets path /assets/*",
  "handle @assets",
  "@spa method GET HEAD",
  "handle @spa",
  "respond 404",
];
let cursor = -1;
for (const token of ordered) {
  const next = caddy.indexOf(token);
  assert.ok(next > cursor, `${token} must appear in route order`);
  cursor = next;
}
assert.match(caddy, /reverse_proxy api:3000/);
assert.match(caddy, /try_files \{path\} \/index\.html/);
assert.doesNotMatch(caddy, /request_body|max_size|rate_limit/);
```

Assert the exact CSP is present as one uninterrupted value. Also assert HSTS, `nosniff`, `SAMEORIGIN`, `strict-origin-when-cross-origin`, zstd/gzip, immutable asset caching, and `no-cache` for `/index.html`.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test deploy/production/test/edge-contract.test.mjs`

Expected: FAIL because the edge files do not exist.

- [ ] **Step 3: Implement the edge image**

Build admin dependencies with the same manifest-first and frozen-lockfile pattern as Task 3. The runtime stage must be exactly:

```dockerfile
FROM caddy:2.11.4-alpine AS runtime
COPY deploy/production/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/admin/dist /srv
RUN addgroup -S -g 10001 markiro \
 && adduser -S -D -H -u 10001 -G markiro markiro \
 && setcap -r /usr/bin/caddy \
 && chown -R 10001:10001 /srv /data /config
USER 10001:10001
```

The official binary carries `cap_net_bind_service`; remove that file capability because this image binds only high internal ports and Compose drops the capability bounding set. Do not set runtime environment variables in the image and do not copy the repository or Node runtime into the Caddy stage.

- [ ] **Step 4: Implement the ordered Caddy route**

Use one HTTP redirect site and one HTTPS application site. The HTTP site listens through internal port 8080 and redirects to the external standard URL `https://{$MARKIRO_DOMAIN}{uri}` without leaking internal port 8443. The HTTPS site contains one `route` block with mutually exclusive `handle`/`handle_path` blocks in the exact order from the test. The SPA handle must be method-matched to GET/HEAD, run `try_files {path} /index.html`, then `file_server`; the final `respond 404` catches all other methods and paths.

Set global ACME email with `email {$ACME_EMAIL}`, `http_port 8080`, `https_port 8443`, and `auto_https disable_redirects`; the explicit HTTP site supplies the correct redirect while the host publishes standard ports 80 and 443. Add `encode zstd gzip` to the HTTPS site. Apply this exact CSP:

```text
default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; img-src 'self' data: blob:; font-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'
```

Set `Cache-Control: no-cache` inside the GET/HEAD SPA handle so root, direct `index.html`, and rewritten deep links all receive it; use the earlier asset handle to set `Cache-Control: public, max-age=31536000, immutable`. Remove `Server` from responses. Do not add a rate-limit or generic body-size directive.

- [ ] **Step 5: Validate syntax, contracts, and the built SPA**

Run:

```bash
docker run --rm -v "$PWD/deploy/production/Caddyfile:/etc/caddy/Caddyfile:ro" -e MARKIRO_DOMAIN=localhost -e ACME_EMAIL=ops@example.test caddy:2.11.4-alpine caddy validate --config /etc/caddy/Caddyfile
node --test deploy/production/test/edge-contract.test.mjs
docker build --file deploy/production/edge.Dockerfile --tag markiro-edge:test .
docker run --rm --entrypoint sh markiro-edge:test -c 'test -f /srv/index.html && ! find /srv -name "*.ts" -print -quit | grep -q .'
```

Expected: Caddy validation, contract test, build, and artifact checks all exit 0.

- [ ] **Step 6: Commit the edge image**

```bash
git add deploy/production/edge.Dockerfile deploy/production/Caddyfile deploy/production/test/edge-contract.test.mjs
git commit -m "build: add production admin edge"
```

### Task 5: Production Compose, secret contract, and preflight

**Files:**

- Create: `compose.production.yml`
- Create: `deploy/production/compose.ci.yml`
- Create: `.env.production.example`
- Create: `deploy/production/preflight.mjs`
- Create: `deploy/production/test/compose-contract.test.mjs`
- Create: `deploy/production/test/preflight.test.mjs`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: `MARKIRO_IMAGE_TAG`, `MARKIRO_API_IMAGE_DIGEST`, `MARKIRO_EDGE_IMAGE_DIGEST`, `MARKIRO_DOMAIN`, `ACME_EMAIL`, optional `MARKIRO_ENV_FILE`, and the complete validated API environment.
- Produces: hardened `migrate`/`api`/`edge` production services, CI-only dependency services, and `runPreflight(environment, dependencies): Promise<PreflightResult>` returning a `PreflightResult` with `imageTag`, `apiImageDigest`, `edgeImageDigest`, `domain`, `acmeEmail`, and `envFile`.

- [ ] **Step 1: Write failing static Compose contracts**

In `compose-contract.test.mjs`, read the production and CI YAML as text and assert the production source contains exactly three top-level service keys: `migrate`, `api`, and `edge`. Assert exact GHCR image interpolation, `service_completed_successfully`, API `service_healthy`, `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp` tmpfs with `size=64m`, `stop_grace_period: 30s`, Caddy data/config named volumes, and edge-only port publication.

Assert production source contains none of:

```js
[/postgres:/, /mailpit/, /minio/, /build:/, /\.\//, /source:/, /5432:/, /3000:/];
```

Assert the CI overlay adds `postgres:17-alpine`, `axllent/mailpit:v1.30.0`, the already-pinned MinIO images from `docker-compose.dev.yml`, a bucket initializer, and test-only host port defaults 18080/18443. Assert `.env.production.example` lists every key accepted by `loadEnv()` and every value after `=` is blank.

- [ ] **Step 2: Write failing preflight tests**

Export a dependency-injected function so tests need no real files or Docker:

```js
/**
 * @typedef {object} PreflightEnvironment
 * @property {string | undefined} MARKIRO_IMAGE_TAG
 * @property {string | undefined} MARKIRO_API_IMAGE_DIGEST
 * @property {string | undefined} MARKIRO_EDGE_IMAGE_DIGEST
 * @property {string | undefined} MARKIRO_DOMAIN
 * @property {string | undefined} ACME_EMAIL
 * @property {string | undefined} MARKIRO_ENV_FILE
 */
/**
 * @typedef {object} PreflightResult
 * @property {string} imageTag
 * @property {string} apiImageDigest
 * @property {string} edgeImageDigest
 * @property {string} domain
 * @property {string} acmeEmail
 * @property {string} envFile
 */
/**
 * @callback RunPreflight
 * @param {PreflightEnvironment} environment
 * @param {{
 *   mode(path: string): Promise<number>,
 *   composeQuiet(environment: PreflightEnvironment): Promise<void>
 * }} dependencies
 * @returns {Promise<PreflightResult>}
 */
```

Test acceptance of a lowercase 40-hex SHA, two lowercase `sha256:` plus 64-hex digest selectors, DNS hostname `app.markiro.example`, ordinary email, and mode `0o600`. Test rejection of missing, uppercase, malformed, full-repository, or tag-only digest inputs; `latest`; 7/39/41-character hashes; uppercase hashes; a domain with scheme/path/port; invalid email; missing file; mode 0644; and any failed quiet Compose validation. Assert error messages name only the invalid variable or file mode and never contain environment values.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test deploy/production/test/compose-contract.test.mjs deploy/production/test/preflight.test.mjs`

Expected: FAIL because production Compose and preflight do not exist.

- [ ] **Step 4: Implement production Compose**

Use these service contracts:

- `migrate`: API digest image, `env_file`, `restart: "no"`, command `node node_modules/@markiro/db/dist/migrate-cli.js`, read-only root, 64 MiB `/tmp`, all capabilities dropped, no-new-privileges.
- `api`: same image/env/hardening, `depends_on.migrate.condition: service_completed_successfully`, healthcheck `node /opt/markiro/healthcheck.mjs` every 10 seconds with 3-second timeout, 12 retries, 20-second start period, private `expose: ["3000"]`, no `ports`, and 30-second stop grace.
- `edge`: edge digest image, only `MARKIRO_DOMAIN` and `ACME_EMAIL` environment, `depends_on.api.condition: service_healthy`, unprivileged UID/GID 10001, read-only root with writable named `/data` and `/config`, 64 MiB `/tmp`, all capabilities dropped, no-new-privileges, and default host mappings `${MARKIRO_HTTP_PORT:-80}:8080` and `${MARKIRO_HTTPS_PORT:-443}:8443`.

Production image references must use exact repository digest interpolation. The CI overlay alone replaces them with local `${MARKIRO_IMAGE_TAG:?MARKIRO_IMAGE_TAG is required}` tags so the bundle gate never pulls registry images. Env file interpolation must be `${MARKIRO_ENV_FILE:-.env.production}`.

- [ ] **Step 5: Implement the CI-only overlay and blank env inventory**

Copy the exact development image pins and healthchecks for PostgreSQL, Mailpit, MinIO, and bucket initialization into the overlay. Do not override production container security settings. Give test dependencies Compose DNS names and set CI-only host ports through `MARKIRO_HTTP_PORT=18080` and `MARKIRO_HTTPS_PORT=18443` in the workflow, not as new production defaults.

List these blank keys in `.env.production.example`, with comments explaining source/rotation outside the values:

```dotenv
DATABASE_URL=
BETTER_AUTH_SECRET=
BETTER_AUTH_URL=
ADMIN_ORIGIN=
KIOSK_ORIGIN=
PAIRING_CODE_PEPPER=
SMTP_HOST=
SMTP_PORT=
SMTP_SECURE=
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=
SMTP_REPLY_TO=
MAIL_PAYLOAD_ENCRYPTION_KEY=
S3_ENDPOINT=
S3_REGION=
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_FORCE_PATH_STYLE=
```

Set `NODE_ENV=production`, `PORT=3000`, and `TRUST_PROXY_HOPS=1` directly on API/migrate services so operators cannot weaken those bundle invariants through the secret file.

- [ ] **Step 6: Implement preflight and ignore private local state**

Validate tag with `/^[0-9a-f]{40}$/`, each digest selector with `/^sha256:[0-9a-f]{64}$/`, domain with `/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/`, and email with a single-`@` plus non-empty local/domain parts. Resolve env file from `MARKIRO_ENV_FILE || ".env.production"`; require `(mode & 0o777) === 0o600`. Spawn only:

```text
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml config --quiet
```

Pass the six non-secret release variables through the child environment, inherit no stdout, capture stderr without echoing it, and throw the stable message `Compose validation failed` on non-zero exit.

Add these ignores:

```gitignore
.env.production
.markiro-releases/
deploy/production/.caddy-data/
deploy/production/.caddy-config/
```

- [ ] **Step 7: Verify contracts and real quiet interpolation**

Run: `corepack pnpm test:production-bundle:contract`

Expected: PASS.

Create a mode-0600 temporary env file from the example with test-only values, then run:

```bash
MARKIRO_IMAGE_TAG=0123456789abcdef0123456789abcdef01234567 MARKIRO_API_IMAGE_DIGEST=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa MARKIRO_EDGE_IMAGE_DIGEST=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb MARKIRO_DOMAIN=localhost ACME_EMAIL=ops@example.test MARKIRO_ENV_FILE="$temp_env" node deploy/production/preflight.mjs
```

Expected: exit 0 and one stable `Production bundle preflight passed` line; no expanded environment or Compose document is printed.

- [ ] **Step 8: Commit Compose and preflight**

```bash
git add .gitignore .env.production.example compose.production.yml deploy/production/compose.ci.yml deploy/production/preflight.mjs deploy/production/test/compose-contract.test.mjs deploy/production/test/preflight.test.mjs
git commit -m "build: define production compose contract"
```

### Task 6: Reproducible deploy orchestration and production smoke

**Files:**

- Create: `deploy/production/deploy.mjs`
- Create: `deploy/production/smoke.mjs`
- Create: `deploy/production/test/deploy.test.mjs`
- Create: `deploy/production/test/smoke-route-table.test.mjs`

**Interfaces:**

- Consumes: successful `runPreflight`; production/CI Compose files; approved repository digests; public edge URL.
- Produces: `deployRelease(options, runner): Promise<ReleaseRecord>` and `runSmoke(options, client, docker): Promise<void>`.

- [ ] **Step 1: Write failing deploy-order tests**

Use an injected runner that records `command`, `args`, and redacted environment key names. For tag `0123456789abcdef0123456789abcdef01234567`, assert this exact successful sequence:

```text
preflight
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml pull api edge
docker image inspect --format {{json .RepoDigests}} ghcr.io/thevladbog/markiro-api@${MARKIRO_API_IMAGE_DIGEST}
docker image inspect --format {{json .RepoDigests}} ghcr.io/thevladbog/markiro-edge@${MARKIRO_EDGE_IMAGE_DIGEST}
write release record with state=pending
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm migrate
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps api
poll docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml exec -T api node /opt/markiro/healthcheck.mjs
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml up -d --no-deps edge
poll the HTTPS liveness endpoint for bounded edge/TLS readiness
run exactly one full smoke
write release record with state=healthy
```

The edge/TLS readiness probe is dependency-injected. It retries transient
connection, TLS, and HTTP-status failures within a stage-specific timeout and
reports only a sanitized last cause. Add failure tests proving migration
failure never calls either `up`, API readiness failure never calls edge `up`,
edge/TLS failure never calls smoke, and public-smoke failure writes state
`failed` while preserving both image digests and previous tag. Assert runner
logs contain no environment values.

- [ ] **Step 2: Write the complete route-smoke table as data**

In `smoke-route-table.test.mjs`, import `ROUTE_CHECKS` and assert it contains these exact cases:

| method | path                    | expected behavior                              |
| ------ | ----------------------- | ---------------------------------------------- |
| GET    | `/`                     | 200 HTML admin shell                           |
| GET    | `/assets/${assetName}`  | 200, immutable cache                           |
| GET    | `/team/deep-link`       | 200 admin shell, no-cache                      |
| GET    | `/api/auth/get-session` | not SPA; upstream path retains `/api/auth/`    |
| GET    | `/api/health/live`      | 200 JSON from upstream `/health/live`          |
| GET    | `/api/health/ready`     | 200 JSON from upstream `/health/ready`         |
| GET    | `/station/bootstrap`    | not SPA                                        |
| GET    | `/kiosk/bootstrap`      | not SPA                                        |
| POST   | `/1c_exchange`          | not SPA and request body reaches API unchanged |
| GET    | `/health/live`          | 200 JSON                                       |
| GET    | `/health/ready`         | 200 JSON `ok` or `degraded`                    |
| GET    | `/openapi.json`         | 200 JSON                                       |
| GET    | `/docs`                 | upstream HTML, not admin shell                 |
| POST   | `/unknown`              | 404, not HTML                                  |

Add checks for exact CSP, HSTS on HTTPS, nosniff, SAMEORIGIN, referrer policy, and absence of external origins in built `index.html` URL-bearing attributes.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test deploy/production/test/deploy.test.mjs deploy/production/test/smoke-route-table.test.mjs`

Expected: FAIL because deploy and smoke modules do not exist.

- [ ] **Step 4: Implement deploy orchestration without secret output**

Export:

```js
/**
 * @typedef {object} ReleaseRecord
 * @property {string} tag
 * @property {string | null} previousTag
 * @property {string} apiDigest
 * @property {string} edgeDigest
 * @property {"pending" | "healthy" | "failed"} state
 * @property {string} createdAt
 */
/**
 * @typedef {object} DeployOptions
 * @property {Record<string, string | undefined>} environment
 * @property {string=} releaseDirectory
 * @property {number=} readinessAttempts
 * @property {number=} readinessIntervalMs
 */
/**
 * @callback DeployRelease
 * @param {DeployOptions} options
 * @param {DeployDependencies=} dependencies
 * @returns {Promise<ReleaseRecord>}
 */
```

Default to 30 readiness attempts at 2,000 ms intervals. Store records under `.markiro-releases/${timestamp}-${MARKIRO_IMAGE_TAG}.json` with mode 0600. Resolve the previous healthy tag from the newest healthy local record. Use argument arrays with `spawn`, never a shell string. Child processes receive the existing environment but logs show only command names and lifecycle state; captured stderr is summarized as `${command} failed with exit ${code}`.

Do not automatically roll back a failed post-switch smoke: preserve evidence and return non-zero. The runbook's explicit rollback command uses the recorded previous tag after an operator confirms migration compatibility.

- [ ] **Step 5: Implement HTTP and container smoke checks**

Export `ROUTE_CHECKS` as immutable data and make `runSmoke()` execute it with a 5,000 ms timeout per request. Identify the admin shell by the built root's `<title>` plus module-script asset path, then reject that signature on every proxied/404 response. For `/1c_exchange`, POST `type=catalog&mode=checkauth` as `application/x-www-form-urlencoded` and accept its protocol authentication response status while rejecting SPA HTML.

Inspect runtime properties with argument-array Docker calls:

```text
docker compose ... port api 3000        => must fail or return empty
docker compose ... exec -T api id -u    => non-zero UID
docker compose ... exec -T api test -w / => must fail
```

For graceful shutdown in CI, capture the API container ID, run `docker stop --time 25 ${containerId}`, assert exit within 30 seconds, then restore with the same Compose argument array plus `up -d --no-deps api` and wait for readiness. Production deploy smoke skips the destructive shutdown subcheck unless `SMOKE_ASSERT_SHUTDOWN=1`.

- [ ] **Step 6: Run module tests and a local orchestration dry run**

Run: `corepack pnpm test:production-bundle:contract`

Expected: PASS.

Run the deploy test with a fake runner only; verify no actual Docker command or release write occurs outside its temporary directory.

- [ ] **Step 7: Commit deploy and smoke tooling**

```bash
git add deploy/production/deploy.mjs deploy/production/smoke.mjs deploy/production/test/deploy.test.mjs deploy/production/test/smoke-route-table.test.mjs
git commit -m "feat: add production deploy and smoke tooling"
```

### Task 7: CI bundle gate and digest-evidenced image publication

**Files:**

- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-images.yml`
- Create: `deploy/production/test/workflow-contract.test.mjs`

**Interfaces:**

- Consumes: both Dockerfiles, both Compose files, smoke tooling, GitHub commit SHA, GHCR credentials supplied by GitHub Actions.
- Produces: PR production-bundle gate and main-branch API/edge SHA tags with trusted digest evidence.

- [ ] **Step 1: Write failing workflow contracts**

Read both workflow files as text and assert:

- CI has a `production-bundle` job with a 20-minute timeout and no `packages: write` permission.
- CI builds both images using the current `${{ github.sha }}` as the only tag.
- CI creates a temporary environment file with mode 0600 without echoing secrets to logs.
- CI starts only CI dependency services first, runs `migrate` twice, then starts API/edge, runs smoke with shutdown assertion, shows `docker compose logs --no-color` only on failure, and always runs `down --volumes --remove-orphans`.
- Release workflow triggers only on pushes to `main`, grants `contents: read` and `packages: write`, logs into `ghcr.io` with `GITHUB_TOKEN`, builds from the exact Dockerfiles, pushes only `${{ github.sha }}` tags, and records validated build-push digest outputs after both pushes.
- Neither workflow contains `:latest`, a branch-name image tag, `docker compose config` without `--quiet`, or a command that prints `.env.production`.

- [ ] **Step 2: Run the workflow contract and verify RED**

Run: `node --test deploy/production/test/workflow-contract.test.mjs`

Expected: FAIL because the jobs/workflow are absent.

- [ ] **Step 3: Add the production-bundle CI job**

Use existing pinned checkout, pnpm setup, and Node setup action SHAs. The job must:

1. install with frozen lockfile;
2. run production-bundle contract tests;
3. build local GHCR-named API and edge images tagged with `${{ github.sha }}`;
4. write a test-only env file under `${{ runner.temp }}` and `chmod 600` it;
5. set `MARKIRO_DOMAIN=localhost`, test port variables 18080/18443, and the test environment path at job scope;
6. run quiet preflight;
7. start `postgres mailpit minio`, wait healthy, and run `minio-init` through the CI overlay;
8. run `migrate` twice as one-off containers;
9. start API and edge with `up -d --wait --wait-timeout 120`;
10. run `MARKIRO_SMOKE_CI_OVERLAY=1 SMOKE_ASSERT_SHUTDOWN=1 node deploy/production/smoke.mjs` so shutdown restoration retains the fixed local-image override;
11. emit sanitized Compose logs only under `if: failure()`;
12. remove containers and volumes under `if: always()`.

Use GitHub secret masking commands for every generated test credential before any Docker command. Generated values are CI-only and must not be copied into `.env.production.example`.

- [ ] **Step 4: Add SHA-tag main publication and digest evidence**

Create one workflow job using these immutable action revisions:

```yaml
- uses: docker/setup-buildx-action@e468171a9de216ec08956ac3ada2f0791b6bd435 # v3.11.1
- uses: docker/login-action@184bdaa0721073962dff0199f1fb9940f07167d1 # v3.5.0
- uses: docker/build-push-action@263435318d21b8e681c14492fe198d362a7d2c83 # v6.18.0
```

Use the build-push action once per image. Build API and edge from their exact Dockerfiles, set `push: true`, and tag only:

```text
ghcr.io/thevladbog/markiro-api:${{ github.sha }}
ghcr.io/thevladbog/markiro-edge:${{ github.sha }}
```

Do not publish `latest`, `main`, a short SHA, or an unpinned semver alias. Add action-SHA comments with the upstream major version, matching existing workflow style.

Give both build-push steps stable IDs. After both pushes succeed, validate that
each `digest` output is lowercase `sha256:` plus 64 hex characters and write the
full SHA plus both repository digest references to `$GITHUB_STEP_SUMMARY`.
This successful Actions evidence is the production trust boundary; the SHA tag
itself remains mutable.

- [ ] **Step 5: Validate workflow contracts and YAML parsing**

Run: `corepack pnpm test:production-bundle:contract`

Expected: PASS.

Run: `ruby -e 'require "yaml"; ARGV.each { |path| YAML.load_file(path) }' .github/workflows/ci.yml .github/workflows/release-images.yml`

Expected: exit 0.

- [ ] **Step 6: Run the real local bundle smoke**

With Docker running, execute the same sequence as the CI job using a temporary mode-0600 environment file and the CI overlay. Run migration twice, wait for edge, run the route/security/runtime smoke, and always run:

```bash
docker compose --env-file "$temp_env" -f compose.production.yml -f deploy/production/compose.ci.yml down --volumes --remove-orphans
```

Expected: both migrations exit 0; all smoke checks pass; API graceful stop completes within 30 seconds; cleanup exits 0.

- [ ] **Step 7: Commit CI and release publication**

```bash
git add .github/workflows/ci.yml .github/workflows/release-images.yml deploy/production/test/workflow-contract.test.mjs
git commit -m "ci: verify and publish production images"
```

### Task 8: Operator deploy and rollback runbook

**Files:**

- Create: `docs/runbooks/saas-production-deploy.md`
- Create: `deploy/production/test/runbook-contract.test.mjs`
- Create: `deploy/production/verify-dns.mjs`
- Create: `deploy/production/test/dns-verification.test.mjs`
- Modify: `docs/superpowers/specs/2026-08-04-saas-production-bundle-design.md`

**Interfaces:**

- Consumes: `preflight.mjs`, `deploy.mjs`, `smoke.mjs`, local release records, cabinet RBAC provisioning runbook.
- Produces: an executable first-deploy, routine-deploy, failure-triage,
  rollback, and public-go-live procedure, plus a bounded injected DNS verifier
  for exact authoritative/public A and AAAA sets.

- [ ] **Step 1: Write the failing runbook contract**

Assert the runbook contains explicit commands and stop conditions for:

- validating mode 0600 without printing the file;
- verifying managed-PostgreSQL backup freshness and object-storage retention/versioning;
- pinning and recording the 40-character SHA plus both preapproved digests;
- running preflight and `deploy.mjs`;
- cabinet root, auth boundary, device route, and first-owner smoke;
- provisioning the first tenant owner with the existing CLI after health is green;
- rejecting a release when migration, readiness, or smoke fails;
- rollback by setting the recorded previous tag and re-running preflight/migrate/API/edge in order;
- explicitly forbidding reverse migrations, hand-edited containers, hand-edited production rows, rendered Compose output, and secret values in tickets/chat;
- retaining the previous tag and release record through the observation window;
- verifying provider/WAF rate limiting or the separately reviewed custom-Caddy
  alternative before DNS, with public application maintenance/deny active and
  the operator or synthetic smoke source allowlisted;
- transparently passing the ACME HTTP-01 challenge when Caddy terminates TLS,
  or requiring a separately verified pre-provisioned certificate/custom-edge
  procedure when the provider terminates TLS;
- switching DNS only through an approved external procedure, then bounded
  authoritative and public DNS verification before edge start. The executable
  verifier compares the exact normalized A and AAAA sets, uses `+norecurse`
  and requires the QR and AA flags at the explicit authoritative server, and
  requires every listed public recursive resolver to return the QR and RA flags
  for both families and have neither missing nor extra addresses. Every
  A/AAAA RR owner must match the requested domain case-insensitively after
  optional trailing-dot normalization. For an empty approved family, zero
  answers require NODATA proof from a SOA-only authority section whose SOA
  owners are the requested domain or a label-boundary ancestor. Only a final
  non-truncated response is accepted; the TC flag, truncation/retry diagnostics,
  mixed SOA-plus-NS referrals, malformed output, suffix-confusion SOA owners,
  CNAME, and other unsupported shapes fail closed;
- bounded edge/TLS readiness, exactly one full smoke, and public traffic open
  only after the healthy release record exists.

- [ ] **Step 2: Run the contract and verify RED**

Run: `node --test deploy/production/test/runbook-contract.test.mjs`

Expected: FAIL because the runbook does not exist.

- [ ] **Step 3: Write the first-deploy and routine-deploy procedures**

Use concrete commands with absolute operator variables, for example:

```bash
read -r -p 'Approved 40-character git SHA: ' MARKIRO_IMAGE_TAG
read -r -p 'Approved API digest (sha256:...): ' MARKIRO_API_IMAGE_DIGEST
read -r -p 'Approved edge digest (sha256:...): ' MARKIRO_EDGE_IMAGE_DIGEST
export MARKIRO_IMAGE_TAG MARKIRO_API_IMAGE_DIGEST MARKIRO_EDGE_IMAGE_DIGEST
export MARKIRO_DOMAIN=app.example.ru
export ACME_EMAIL=ops@example.ru
export MARKIRO_ENV_FILE=/etc/markiro/production.env
stat -f '%Lp %N' "$MARKIRO_ENV_FILE"   # macOS inspection
stat -c '%a %n' "$MARKIRO_ENV_FILE"   # Linux inspection
node deploy/production/preflight.mjs
node deploy/production/deploy.mjs
```

State that preflight rejects anything except the approved full lowercase SHA and both approved digest selectors. Link first-owner semantics to `docs/runbooks/cabinet-rbac-rollout.md`, collect the three non-secret inputs without putting them in shell history, and run the compiled CLI from the same digest-pinned API image:

```bash
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -p 'Tenant display name: ' TENANT_NAME
read -r -p 'Tenant slug: ' TENANT_SLUG
docker compose --env-file "$MARKIRO_ENV_FILE" -f compose.production.yml run --rm --no-deps api \
  node dist/cli/provision-tenant-owner.js \
  --email "$OWNER_EMAIL" \
  --tenant-name "$TENANT_NAME" \
  --tenant-slug "$TENANT_SLUG"
unset OWNER_EMAIL TENANT_NAME TENANT_SLUG
```

Require a green API/edge smoke before this command and retain only its four non-sensitive identifiers in the protected rollout record.

- [ ] **Step 4: Write failure and rollback decision tables**

For each failure phase—pull, migration, API readiness, edge start, post-switch smoke—state what remains running, which logs are safe to collect, whether rollback is allowed, and the exact next command. Rollback is allowed only after confirming the failed release's migrations are backward-compatible with the previous image. Never instruct the operator to reverse SQL.

Add a separate public-go-live checklist whose final pre-DNS hard gate is an
evidenced provider/WAF per-source and global anonymous-route limit, or the
separately reviewed reproducible custom Caddy image. The standard Caddy bundle
alone cannot satisfy that gate. The first-deploy order is maintenance/deny and
allowlist evidence, ACME HTTP-01 pass-through (or the verified provider TLS
alternative), approved DNS switch, bounded authoritative and public DNS
verification of the exact normalized A and AAAA sets (`+norecurse` plus QR and
AA flags at the authoritative server, then the QR and RA flags from every
public recursive resolver). Every A/AAAA RR owner must match the requested
domain after case-insensitive/trailing-dot normalization. An empty approved
family requires zero-answer NODATA proof with a SOA-only authority section whose
SOA owners are the requested domain or a label-boundary ancestor. The verifier
accepts only a final non-truncated response and rejects the TC flag and
truncation/retry diagnostics. Next come edge/TLS readiness,
exactly one full smoke, the healthy record, and only then public traffic open.
CNAME is outside this procedure and fails closed. Routine deploy explicitly
assumes DNS and valid TLS already exist. Do not add fictional provider
commands.

- [ ] **Step 5: Mark the design implemented only after all evidence exists**

At the top of the design spec change status from `Approved` to `Implemented and verified` only after Tasks 1–7 pass locally. Append an implementation-evidence section listing the exact full verification commands and the resulting commit SHAs; do not claim the GitHub-hosted CI result until the pushed PR reports it.

- [ ] **Step 6: Run doc contracts and repository formatting**

Run:

```bash
node --test deploy/production/test/runbook-contract.test.mjs
corepack pnpm prettier --check docs/runbooks/saas-production-deploy.md docs/superpowers/specs/2026-08-04-saas-production-bundle-design.md
```

Expected: PASS.

- [ ] **Step 7: Commit the runbook**

```bash
git add docs/runbooks/saas-production-deploy.md docs/superpowers/specs/2026-08-04-saas-production-bundle-design.md deploy/production/test/runbook-contract.test.mjs deploy/production/verify-dns.mjs deploy/production/test/dns-verification.test.mjs
git commit -m "docs: add SaaS production deploy runbook"
```

### Task 9: Final verification, review, and publication

**Files:**

- Modify only files required by failures or review findings from Tasks 1–8.

**Interfaces:**

- Consumes: all production-bundle artifacts and checks.
- Produces: a clean branch, ready pull request, and monitored GitHub checks.

- [ ] **Step 1: Run the complete automated gate**

Run in this order:

```bash
corepack pnpm format:check
corepack pnpm turbo lint typecheck test build
corepack pnpm test:production-bundle:contract
```

Expected: every command exits 0. Record existing warnings separately; fix every warning introduced by this branch.

- [ ] **Step 2: Repeat the clean production-bundle smoke**

Build both images without cache, use a fresh Compose project name and fresh CI volumes, run the runtime migration twice, boot the production bundle, run every smoke check including shutdown, and clean up unconditionally. Expected: all checks pass from a clean Docker context and no old volume or image state is required.

- [ ] **Step 3: Inspect image contents and security settings**

Assert API UID is non-zero, root filesystem is non-writable, port 3000 has no host mapping, both base-image tags are exact, migrations exist, runtime migrator executes without `drizzle-kit`, edge contains no Node executable/source/env file, and image history contains no secret values from the CI env file.

- [ ] **Step 4: Review the complete branch diff against the approved spec**

Run:

```bash
git diff --check main...HEAD
git diff --stat main...HEAD
git status --short
```

Read every changed file. Map each acceptance criterion to a passing test or explicit runbook section. Search committed files for `postgres://`, private hostnames, nonblank production example values, `:latest`, `drizzle-kit` in runtime files, source bind mounts, external CSP origins, and unredacted Compose/config output. Fix every actionable finding and rerun the smallest affected check followed by the complete automated gate.

- [ ] **Step 5: Request code review and resolve all actionable findings**

Use the requesting-code-review skill against `main...HEAD`. Validate each finding against current code and spec before changing it. Implement all valid findings with focused regression tests and commits; document rejected findings with concrete code/test evidence.

- [ ] **Step 6: Push and open the ready pull request**

Push `codex/saas-production-bundle`, then create a non-draft PR. The PR body must summarize runtime migrations, readiness semantics, image/Compose hardening, route behavior, CI smoke, image publication, and runbook; list automated commands separately from GitHub-hosted CI; and explicitly state that Yandex Cloud provisioning and the public edge-rate-limit gate remain the next slice.

- [ ] **Step 7: Monitor checks and review comments through green**

Poll the PR checks and review threads. For each failure or comment, retrieve full logs/context, determine whether it applies to the current commit, reproduce locally where possible, add a regression test, fix, commit, and push. Finish only when required checks pass and no unresolved actionable review thread remains.
