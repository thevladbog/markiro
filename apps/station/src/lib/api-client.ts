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
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { "x-api-key": cfg.apiKey } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new StationApiError(res.status, await readError(res));
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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
