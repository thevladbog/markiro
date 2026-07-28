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
 * Redeems a pairing code. Deliberately NOT a method on the token-bearing
 * client: the device has no token until this succeeds, mirroring the server,
 * where this is the one route outside `KioskDeviceGuard`.
 */
export async function pairKiosk(serverUrl: string, code: string): Promise<PairKioskResultDto> {
  const res = await fetch(`${baseOf(serverUrl)}/kiosk/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new KioskApiError(res.status, await readError(res));
  return (await res.json()) as PairKioskResultDto;
}

export interface KioskClient {
  bootstrap(): Promise<KioskBootstrapDto>;
  submitOrder(body: CreateOrderDto): Promise<CreateOrderResultDto>;
}

export function createKioskClient(cfg: { token: string; serverUrl: string }): KioskClient {
  const base = baseOf(cfg.serverUrl);

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "x-kiosk-token": cfg.token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new KioskApiError(res.status, await readError(res));
    return (await res.json()) as T;
  }

  return {
    // Every authenticated call bumps `kiosks.last_seen_at` server-side, so a
    // periodic bootstrap doubles as the heartbeat — there is no separate one.
    bootstrap: () => request<KioskBootstrapDto>("GET", "/kiosk/bootstrap"),
    submitOrder: (body) => request<CreateOrderResultDto>("POST", "/kiosk/orders", body),
  };
}
