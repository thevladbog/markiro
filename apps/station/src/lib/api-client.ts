import type { StationConfig } from "./config.js";

export class StationApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StationApiError";
    this.status = status;
  }
}

export interface StationClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  whoami(): Promise<{ ok: true }>;
}

/**
 * Deadline for every station request (Finding 1). A bare `fetch` has no
 * built-in timeout: if the network accepts the TCP connection but the
 * response never completes (a common plant-network failure mode — a
 * middlebox that swallows the FIN, a captive portal that never answers), the
 * `await` in the sync drain would never settle. The engine would stay
 * `draining` forever, so heartbeat and scan nudges only set the "requested"
 * flag and never start a new drain, and `publishState()` never runs again —
 * the operator keeps seeing a stale pending count until the app is
 * restarted. Aborting after a deadline turns that hang into an ordinary
 * rejection, which the drain's existing `catch` already treats as a failed
 * batch: queue left intact, backoff-and-retry scheduled.
 *
 * 30 seconds is chosen to comfortably survive the drain's own worst case: a
 * full `BATCH_SIZE` (200-scan) batch is at most a couple hundred KB of JSON,
 * which even a badly congested plant link (think a saturated shared Wi-Fi or
 * a cellular fallback measured in a few tens of Kbps, not a dead link) can
 * push in a few seconds, leaving over 20 seconds of slack for TLS handshake,
 * DNS, and server-side processing. A dead link does not need a long timeout
 * to eventually recover — the point is only to bound how long ONE stalled
 * attempt can freeze the indicator before the existing retry loop gets
 * another turn.
 */
export const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Fetch client for the SaaS API. Sends the device api-key as `x-api-key`
 * (matching the TenantGuard station path) and prefixes every path with the
 * enrolled `serverUrl`. There is no session cookie — the station is stateless
 * against the server.
 */
export function createStationClient(
  cfg: Pick<StationConfig, "apiKey" | "serverUrl"> &
    Partial<Omit<StationConfig, "apiKey" | "serverUrl">>,
): StationClient {
  const base = (cfg.serverUrl ?? "").replace(/\/+$/, "");

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    // One `AbortController` per attempt, cleared in `finally` so the timer
    // never leaks on the success path (nor on an ordinary HTTP-error path —
    // both go through the same `finally`). `controller.abort()` makes the
    // in-flight `fetch` reject with an `AbortError`, an ordinary promise
    // rejection the caller (the sync drain, or any other station request)
    // already has to handle like any other network failure.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
        },
        signal: controller.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) throw new StationApiError(res.status, await readError(res));
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body),
    // A cheap reachability + auth probe used by enrollment; GET /shifts is
    // TenantGuard-protected, so a 200 proves the key resolves a tenant.
    whoami: async () => {
      await request("GET", "/shifts");
      return { ok: true };
    },
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "message" in body) {
      const message = (body as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
  } catch {
    // non-JSON body
  }
  return res.statusText || `HTTP ${res.status}`;
}
