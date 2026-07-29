import type {
  CreateOrderDto,
  CreateOrderResultDto,
  KioskBootstrapDto,
  PairKioskResultDto,
} from "./types.js";

export class KioskApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "KioskApiError";
    this.status = status;
  }
}

/**
 * A request that ran out of its deadline — DELIBERATELY NOT a `KioskApiError`.
 *
 * The distinction is the whole point: a `KioskApiError` carries the server's
 * verdict on the request, and the drain's quarantine reads a 4xx as "this order
 * will never be accepted". An abort carries no verdict at all — the server may
 * well have taken the order — so it must read as an ordinary transport failure
 * that leaves the order queued for the next drain. Giving it a status would
 * make that mistake available to every future caller.
 */
export class KioskTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs}ms`);
    this.name = "KioskTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * The deadline for a request that carries the WHOLE dataset — the roster, the
 * catalogue and the operator mirror — and therefore the slowest legitimate call
 * the app makes. Pairing redeems into the same payload, so it shares the bound.
 *
 * Generous on purpose, in both directions. Aborting a bootstrap that would have
 * succeeded is not free: the snapshot keeps ageing towards the seven-day
 * lockout, so a deadline shorter than a slow-but-working warehouse link would
 * eventually brick a healthy kiosk by itself. And it stays an order of
 * magnitude below `REFRESH_INTERVAL_MS` (5 min), so a stalled refresh has
 * always given up long before the next tick — the interval can never stack.
 */
export const BOOTSTRAP_TIMEOUT_MS = 30_000;

/**
 * The deadline for filing an order, and shorter than the bootstrap's for one
 * reason: a WORKER IS STANDING HERE. The body is a handful of scanned codes and
 * the reply is four fields, so 15 s is already an order of magnitude above a
 * healthy round trip on a gate link — while a minute of a frozen screen at an
 * unattended kiosk is indistinguishable from a dead one.
 *
 * Timing out costs only the order NUMBER on the confirmation. `submitCart`
 * queues the order durably before any network attempt, so the abort leaves it
 * queued exactly as an outage does and the worker gets the offline
 * confirmation — which is a true statement — instead of an unbounded wait.
 */
export const SUBMIT_TIMEOUT_MS = 15_000;

/**
 * Whether this failure means the DEVICE's own credential is no longer good —
 * the kiosk archived, or a replacement device having redeemed a new token.
 *
 * 401 is the only status `KioskDeviceGuard` produces, and it is definitive
 * rather than a network blink: the token cannot come back. Only worth asking of
 * a BOOTSTRAP failure — `POST /kiosk/orders` answers an unknown badge with a
 * 401 too, which says nothing about the device.
 */
export function isDeviceRevoked(err: unknown): boolean {
  return err instanceof KioskApiError && err.status === 401;
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

function baseOf(serverUrl: string): string {
  return serverUrl.replace(/\/+$/, "");
}

/**
 * Every request this app makes, under a deadline. THE ONLY `fetch` IN `src/`.
 *
 * `fetch` alone has no timeout, and the failure that costs is not a refused
 * connection — it is a HALF-OPEN one. A tablet that walked out of Wi-Fi range
 * mid-request, or one behind a captive portal that swallows the SYN, leaves the
 * promise pending FOREVER: `flushQueue`'s `draining` chain never settles,
 * `submitCart` never reaches the confirmation the worker is waiting for, and
 * every later drain queues behind that same unresolved promise. The kiosk stops
 * without a single error anywhere.
 *
 * THE DEADLINE COVERS THE BODY TOO, not just the headers. `fetch` resolves as
 * soon as the response line arrives, so a connection that dies mid-body would
 * hang in `res.json()` instead — the same stall one await further down. The
 * timer is therefore cleared only after the payload has been read.
 *
 * A `KioskApiError` raised from the status is re-thrown UNTOUCHED even if the
 * deadline has since fired: the server did answer, and turning its verdict into
 * a timeout would hide a revocation behind a retry.
 *
 * ABORT *AND* RACE, which looks like one mechanism too many and is not. The
 * abort is what actually cancels the request and frees the socket, and on a
 * conforming `fetch` it is enough. The race is what makes the guarantee this
 * function exists for — that the returned promise ALWAYS settles — independent
 * of anything in between honouring the signal, and this app puts a service
 * worker in between (`vite-plugin-pwa`) on every request it makes. The stall
 * this closes is silent by nature, so the bound must not rest on somebody
 * else's `fetch` behaving.
 */
async function fetchJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let expire!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = () => {
      controller.abort();
      reject(new KioskTimeoutError(timeoutMs));
    };
  });
  const timer = setTimeout(() => expire(), timeoutMs);

  const attempt = (async (): Promise<T> => {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new KioskApiError(res.status, await readError(res));
    return (await res.json()) as T;
  })();

  try {
    return await Promise.race([attempt, deadline]);
  } catch (err) {
    // The server's own verdict outranks the deadline: it answered.
    if (err instanceof KioskApiError) throw err;
    // Any other failure raised after the abort is a symptom of it — the
    // `AbortError` the platform raises, or a decode that died with the stream —
    // and is reported as the timeout it actually was. `submitCart` passes no
    // signal of its own, so an abort here can only ever be this deadline.
    if (controller.signal.aborted) throw new KioskTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
    // The loser of the race has nobody left waiting on it. Without this, a
    // request that rejects after the deadline surfaces as an unhandled
    // rejection — which on a kiosk is a console nobody reads, and in a test run
    // is a failure in an unrelated file.
    void attempt.catch(() => {});
  }
}

/**
 * Redeems a pairing code. Deliberately NOT a method on the token-bearing
 * client: the device has no token until this succeeds, mirroring the server,
 * where this is the one route outside `KioskDeviceGuard`.
 */
export async function pairKiosk(serverUrl: string, code: string): Promise<PairKioskResultDto> {
  return fetchJson<PairKioskResultDto>(
    `${baseOf(serverUrl)}/kiosk/pair`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    // The redeem answers with a whole bootstrap bundle, so it is a bootstrap's
    // worth of bytes; an installer watching a spinner is also the one person in
    // the building who can simply press «Повторить».
    BOOTSTRAP_TIMEOUT_MS,
  );
}

export interface KioskClient {
  bootstrap(): Promise<KioskBootstrapDto>;
  submitOrder(body: CreateOrderDto): Promise<CreateOrderResultDto>;
}

export function createKioskClient(cfg: { token: string; serverUrl: string }): KioskClient {
  const base = baseOf(cfg.serverUrl);

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    timeoutMs: number,
    body?: unknown,
  ): Promise<T> {
    return fetchJson<T>(
      `${base}${path}`,
      {
        method,
        headers: { "Content-Type": "application/json", "x-kiosk-token": cfg.token },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      timeoutMs,
    );
  }

  return {
    // Every authenticated call bumps `kiosks.last_seen_at` server-side, so a
    // periodic bootstrap doubles as the heartbeat — there is no separate one.
    bootstrap: () => request<KioskBootstrapDto>("GET", "/kiosk/bootstrap", BOOTSTRAP_TIMEOUT_MS),
    submitOrder: (body) =>
      request<CreateOrderResultDto>("POST", "/kiosk/orders", SUBMIT_TIMEOUT_MS, body),
  };
}
