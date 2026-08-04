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

type DependencyName = "database" | "jobs" | "smtp" | "storage";
type ProbeOutcome = { ok: true } | { ok: false };

export class ReadinessService {
  private cached?: { expiresAt: number; report: ReadinessReport };
  private inFlight?: Promise<ReadinessReport>;
  private readonly dependencyCalls: Partial<Record<DependencyName, Promise<ProbeOutcome>>> = {};

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
        delete this.inFlight;
      });
    return this.inFlight;
  }

  private async probe(): Promise<ReadinessReport> {
    const checkedAt = this.dependencies.now().toISOString();
    const [database, jobs, smtp, storage] = await Promise.all([
      this.bounded(
        "database",
        () => this.dependencies.database(),
        checkedAt,
        "unavailable",
        "database_unavailable",
        "database_timeout",
      ),
      this.bounded(
        "jobs",
        () => this.dependencies.jobs(),
        checkedAt,
        "unavailable",
        "jobs_unavailable",
        "jobs_timeout",
      ),
      this.bounded(
        "smtp",
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
        "storage",
        () => this.dependencies.storage(),
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
    dependency: DependencyName,
    run: () => Promise<void>,
    checkedAt: string,
    failureStatus: "degraded" | "unavailable",
    failureCategory: NonNullable<ComponentReport["category"]>,
    timeoutCategory: NonNullable<ComponentReport["category"]>,
  ): Promise<ComponentReport> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.callDependency(dependency, run),
      new Promise<ProbeTimeout>((resolve) => {
        timer = setTimeout(() => resolve(new ProbeTimeout()), PROBE_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (outcome instanceof ProbeTimeout) {
      return { status: failureStatus, category: timeoutCategory, checkedAt };
    }
    if (outcome.ok) {
      return { status: "healthy", checkedAt };
    }
    return { status: failureStatus, category: failureCategory, checkedAt };
  }

  private callDependency(
    dependency: DependencyName,
    run: () => Promise<void>,
  ): Promise<ProbeOutcome> {
    const existing = this.dependencyCalls[dependency];
    if (existing) return existing;

    const pending = Promise.resolve()
      .then(run)
      .then<ProbeOutcome, ProbeOutcome>(
        () => ({ ok: true }),
        () => ({ ok: false }),
      );
    this.dependencyCalls[dependency] = pending;
    void pending.then(() => {
      if (this.dependencyCalls[dependency] === pending) delete this.dependencyCalls[dependency];
    });
    return pending;
  }
}

class ProbeTimeout extends Error {}
