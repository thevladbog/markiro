import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import type { CatalogEnvironment } from "@markiro/platform-contracts";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { ChzTokenService } from "../chz-exports/chz-token.service";
import { CHZ_TRUE_API_BASE_URLS } from "../signer-agents/chz-constants";
import type { CatalogRequestContext } from "./national-catalog-import.types";
import type {
  NationalCatalogAuth,
  NationalCatalogRequestOptions,
  NationalCatalogResponseMetadata,
} from "./national-catalog.types";

export const CATALOG_HTTP_DEADLINE_MS = 15_000;
const LEASE_SECONDS = 60;
const QUOTA_WAIT_SECONDS = 300;
const CATALOG_BASE_URLS = {
  production: "https://апи.национальный-каталог.рф",
  sandbox: "https://api.nk.sandbox.crptech.ru",
} as const;

export function nextRetryAt(attempt: number, now: Date, retryAfterSeconds: number | null): Date {
  const delay = Math.max(Math.min(900, 60 * 2 ** Math.max(0, attempt - 1)), retryAfterSeconds ?? 0);
  return new Date(now.getTime() + delay * 1000);
}

export class CatalogRequestError extends Error {
  constructor(
    readonly state: "deferred" | "blocked" | "retry" | "failed",
    readonly reason: string,
    readonly nextRetryAt: Date | null = null,
    readonly consumesAttempt = false,
  ) {
    super(reason);
    this.name = "CatalogRequestError";
  }
}

export function verifyCatalogEnvironment(
  expected: CatalogEnvironment,
  trueApiBaseUrl: string,
  catalogBaseUrl: string,
): void {
  if (
    !registeredUrl(trueApiBaseUrl, CHZ_TRUE_API_BASE_URLS[expected]) ||
    !registeredUrl(catalogBaseUrl, CATALOG_BASE_URLS[expected])
  ) {
    throw new CatalogRequestError("blocked", "environment_mismatch");
  }
}

function registeredUrl(value: string, expected: string): boolean {
  // URL removes an explicit :443 and normalizes dot paths. Inspect the supplied
  // authority/path too, so normalization cannot turn a forbidden URL into an allowed one.
  const raw = /^https:\/\/([^/?#]+)([^?#]*)$/.exec(value);
  if (!raw?.[1] || raw[1].includes(":") || raw[1].includes("@") || value.includes("\\"))
    return false;
  try {
    const actual = new URL(value);
    const registered = new URL(expected);
    const path = registered.pathname === "/" ? "" : registered.pathname;
    return actual.origin === registered.origin && (raw[2] === path || raw[2] === `${path}/`);
  } catch {
    return false;
  }
}

/** Module-level pool: all coordinator instances in this process share four slots. */
class ProcessSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  async acquire(): Promise<() => void> {
    if (this.active === 4) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    return () => {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    };
  }
}
const processSlots = new ProcessSlots();
const leases = schema.nationalCatalogRequestLeases;
type Lease = { owner: string; fence: bigint };
export type CatalogAttempt = {
  /** Initial HTTP attempt=0; automatic retries=1..3. Persist in the job/session. */ attempt: number;
};
export type CatalogTransport = NationalCatalogRequestOptions & {
  signal: AbortSignal;
  auth: NationalCatalogAuth;
};

/** One attempt per invocation. Deferred outcomes never sleep or consume HTTP attempts.
 * Callers durably save attempt/state/nextRetryAt; reconstruction must pass that saved
 * attempt. Only an explicit manual retry within the session may reset its cycle.
 */
export class NationalCatalogRequestCoordinator {
  constructor(
    private readonly db: Db,
    private readonly tokens: ChzTokenService,
    private readonly catalogBaseUrl: string | undefined,
  ) {}

  async run<T>(
    context: CatalogRequestContext,
    request: (transport: CatalogTransport) => Promise<T>,
    options: CatalogAttempt,
  ): Promise<T> {
    this.verify(context);
    return this.execute(
      context,
      async (signal, onResponse) => {
        const token = await this.tokens.getCatalogToken(context.tenantId, context.environment);
        if (token.status !== "ok") throw new CatalogRequestError("blocked", token.status);
        verifyCatalogEnvironment(
          context.environment,
          token.auth.baseUrl,
          this.catalogBaseUrl ?? "",
        );
        const value = await request({
          signal,
          onResponse,
          auth: { baseUrl: this.catalogBaseUrl ?? "", token: token.auth.token },
        });
        if (statusOf(value) === "unauthorized")
          await this.tokens.invalidateAndRequestRefresh(context.tenantId, token.obtainedAt);
        return value;
      },
      options,
    );
  }

  /** For later CDN preparation. The callback receives only cancellation, never auth.
   * Cached photo application does not call this method: it has no external request.
   */
  async runExternal<T>(
    context: CatalogRequestContext,
    request: (signal: AbortSignal) => Promise<T>,
    options: CatalogAttempt,
  ): Promise<T> {
    this.verify(context);
    return this.execute(context, (signal) => request(signal), options);
  }

  private verify(context: CatalogRequestContext): void {
    verifyCatalogEnvironment(
      context.environment,
      CHZ_TRUE_API_BASE_URLS[context.environment],
      this.catalogBaseUrl ?? "",
    );
  }

  private async acquire(tenantId: string): Promise<Lease> {
    const owner = randomUUID();
    await this.db
      .insert(leases)
      .values({ tenantId, owner, leaseUntil: sql`now()`, nextAllowedAt: sql`now()` })
      .onConflictDoNothing();
    const [claimed] = await this.db
      .update(leases)
      .set({
        owner,
        fence: sql`${leases.fence} + 1`,
        leaseUntil: sql`now() + ${LEASE_SECONDS} * interval '1 second'`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(leases.tenantId, tenantId),
          lte(leases.leaseUntil, sql`now()`),
          lte(leases.nextAllowedAt, sql`now()`),
        ),
      )
      .returning({ fence: leases.fence });
    if (claimed) return { owner, fence: claimed.fence };
    const [busy] = await this.db
      .select({
        next: sql<Date>`greatest(${leases.leaseUntil}, ${leases.nextAllowedAt})`.mapWith(
          leases.nextAllowedAt,
        ),
        quotaWait: sql<boolean>`${leases.nextAllowedAt} > now()`,
      })
      .from(leases)
      .where(eq(leases.tenantId, tenantId));
    throw new CatalogRequestError(
      "deferred",
      busy?.quotaWait ? "quota_wait" : "lease_busy",
      busy?.next ?? null,
    );
  }

  private owned(tenantId: string, lease: Lease) {
    return and(
      eq(leases.tenantId, tenantId),
      eq(leases.owner, lease.owner),
      eq(leases.fence, lease.fence),
    );
  }

  private async execute<T>(
    context: CatalogRequestContext,
    request: (
      signal: AbortSignal,
      observe: (metadata: NationalCatalogResponseMetadata) => void,
    ) => Promise<T>,
    options: CatalogAttempt,
  ): Promise<T> {
    if (
      !options ||
      !Number.isInteger(options.attempt) ||
      options.attempt < 0 ||
      options.attempt > 3
    )
      throw new CatalogRequestError("failed", "invalid_attempt");
    // Wait for process capacity BEFORE claiming a lease. A busy tenant immediately
    // releases this slot, leaving other tenants free to run while it is deferred.
    const releaseSlot = await processSlots.acquire();
    try {
      const lease = await this.acquire(context.tenantId);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CATALOG_HTTP_DEADLINE_MS);
      let metadata: NationalCatalogResponseMetadata | undefined;
      let result: { value: T } | undefined;
      let failure: CatalogRequestError | undefined;
      try {
        result = {
          value: await request(controller.signal, (response) => {
            metadata = response;
          }),
        };
        const status = statusOf(result.value);
        if (controller.signal.aborted)
          failure = new CatalogRequestError("retry", "request_timeout", null, true);
        else if (status === "unauthorized" || status === "forbidden")
          failure = new CatalogRequestError("blocked", status, null, true);
        else if (status === "unavailable" || status === "rate_limited")
          failure = new CatalogRequestError("retry", status, null, true);
      } catch (error) {
        failure =
          error instanceof CatalogRequestError
            ? error
            : new CatalogRequestError(
                "retry",
                controller.signal.aborted ? "request_timeout" : "unavailable",
                null,
                true,
              );
      } finally {
        // Await request settlement/transport cleanup. A non-cooperating callback
        // must not release a slot while its network request is still running.
        clearTimeout(timer);
      }
      const retry = failure?.state === "retry";
      const exhausted = retry && options.attempt === 3;
      const retrySeconds =
        retry && !exhausted
          ? nextRetryAt(
              options.attempt + 1,
              new Date(0),
              metadata?.retryAfterSeconds ?? null,
            ).getTime() / 1000
          : 0;
      const quota = metadata?.usage;
      const exhaustedQuota =
        (quota?.total && quota.total.used >= quota.total.limit) ||
        (quota?.method && quota.method.used >= quota.method.limit);
      const waitSeconds = Math.max(
        retrySeconds,
        metadata?.retryAfterSeconds ?? 0,
        exhaustedQuota ? QUOTA_WAIT_SECONDS : 0,
      );
      const methodQuota = metadata && quota?.method ? { [metadata.method]: quota.method } : {};
      const [accepted] = await this.db
        .update(leases)
        .set({
          leaseUntil: sql`now()`,
          updatedAt: sql`now()`,
          nextAllowedAt: sql`greatest(${leases.nextAllowedAt}, now() + ${waitSeconds} * interval '1 second')`,
          ...(quota?.total ? { totalQuota: quota.total } : {}),
          ...(quota?.method
            ? {
                methodQuotas: sql`coalesce(${leases.methodQuotas}, '{}'::jsonb) || ${JSON.stringify(methodQuota)}::jsonb`,
              }
            : {}),
        })
        .where(and(this.owned(context.tenantId, lease), gt(leases.leaseUntil, sql`now()`)))
        .returning({ nextAllowedAt: leases.nextAllowedAt });
      if (!accepted)
        throw new CatalogRequestError(
          "deferred",
          "lease_lost",
          null,
          failure?.consumesAttempt ?? true,
        );
      if (failure)
        throw new CatalogRequestError(
          exhausted ? "failed" : failure.state,
          failure.reason,
          retry && !exhausted ? accepted.nextAllowedAt : null,
          failure.consumesAttempt,
        );
      if (!result) throw new Error("Catalogue request settled without a result");
      return result.value;
    } finally {
      // The result/quota CAS above is also the lease release. If that write
      // fails, retain the 60s lease until expiry instead of releasing without
      // the received quota. A lost fence must never release its replacement.
      releaseSlot();
    }
  }
}

function statusOf(value: unknown): string | null {
  return value !== null &&
    typeof value === "object" &&
    "status" in value &&
    typeof value.status === "string"
    ? value.status
    : null;
}
