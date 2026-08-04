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
        delete this.inFlight;
      });
    return this.inFlight;
  }

  private async probe(): Promise<ReadinessReport> {
    const checkedAt = this.dependencies.now().toISOString();
    const [database, jobs, smtp, storage] = await Promise.all([
      this.bounded(
        () => this.dependencies.database(),
        checkedAt,
        "unavailable",
        "database_unavailable",
        "database_timeout",
      ),
      this.bounded(
        () => this.dependencies.jobs(),
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
