import { createHmac } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { and, ne, sql } from "drizzle-orm";
import { rateLimitedError, submissionUnavailableError } from "../demo-requests/demo-request.errors";
import {
  NOOP_DEMO_REQUEST_TELEMETRY,
  recordDemoRequestTelemetry,
  type DemoRequestTelemetrySink,
} from "../demo-requests/demo-request.telemetry";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
interface Options {
  windowMs: number;
  sourceBudget: number;
  globalBudget: number;
  sourceKeySecret: string;
}
const windows = schema.landingLeadRateWindows;

/** Shared admission budget for CAPTCHA-free forms; PostgreSQL owns time and serialization. */
export class LandingLeadRateLimiter {
  constructor(
    private readonly db: Db,
    private readonly options: Options,
    private readonly telemetry: DemoRequestTelemetrySink = NOOP_DEMO_REQUEST_TELEMETRY,
  ) {}

  /** Commit even rejected charges; never admit or grow source keys after global exhaustion. */
  async assertAllowed(source: string): Promise<void> {
    const key = `source:${createHmac("sha256", this.options.sourceKeySecret)
      .update(source.trim().slice(0, 128) || "unknown")
      .digest("hex")}`;
    let scope: "global" | "source" | null;
    try {
      scope = await this.db.transaction(async (tx) => {
        if (await this.charge(tx, "global", this.options.globalBudget)) return "global";
        await tx
          .delete(windows)
          .where(
            and(
              ne(windows.key, "global"),
              sql`${windows.windowStartedAt} <= statement_timestamp() - ${this.options.windowMs} * interval '1 millisecond'`,
            ),
          );
        return (await this.charge(tx, key, this.options.sourceBudget)) ? "source" : null;
      });
    } catch {
      throw submissionUnavailableError();
    }
    if (scope !== null) {
      recordDemoRequestTelemetry(this.telemetry, {
        event: "landing_demo_request_rate_limited",
        scope,
      });
      throw rateLimitedError();
    }
  }

  /** The global row is always locked first, ordering all concurrent source transactions. */
  private async charge(tx: Transaction, key: string, budget: number): Promise<boolean> {
    const expired = sql`${windows.windowStartedAt} <= statement_timestamp() - ${this.options.windowMs} * interval '1 millisecond'`;
    const [row] = await tx
      .insert(windows)
      .values({ key, windowStartedAt: sql`statement_timestamp()`, attempts: 1 })
      .onConflictDoUpdate({
        target: windows.key,
        set: {
          windowStartedAt: sql`CASE WHEN ${expired} THEN statement_timestamp() ELSE ${windows.windowStartedAt} END`,
          attempts: sql`CASE WHEN ${expired} THEN 1 ELSE LEAST(${windows.attempts} + 1, ${budget + 1}) END`,
        },
      })
      .returning({ attempts: windows.attempts });
    if (!row) throw new Error("Missing admission counter");
    return row.attempts > budget;
  }
}
