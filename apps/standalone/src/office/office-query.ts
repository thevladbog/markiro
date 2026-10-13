import {
  QueryClient,
  useMutation,
  useQuery,
  type QueryKey,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import type { HostApi } from "../host/api.js";
import { useOfficeSession } from "./office-session.js";

/** Query keys of office data, one per host resource. */
export const officeKeys = {
  org: ["office", "org"],
  orgLogo: ["office", "org-logo"],
  palletSheets: ["office", "pallet-sheets"],
  sscc: ["office", "sscc"],
  users: ["office", "users"],
  devices: ["office", "devices"],
  counterparties: ["office", "counterparties"],
  lines: ["office", "lines"],
  operators: ["office", "operators"],
  /** The site's register of people and their links to operators (host migration 0018). */
  employees: ["office", "employees"],
  badgeSalt: ["office", "badge-salt"],
  productGroups: ["office", "product-groups"],
  products: ["office", "products"],
  templates: ["office", "templates"],
  templateDefaults: ["office", "template-defaults"],
  /** The copies of the database in both folders (plan РК). */
  backups: ["office", "backups"],
  /** Every list of shifts, whatever its period: a write reads them all again. */
  shifts: ["office", "shifts"],
  /** The list of shifts of a period of production dates, or the host's own list (`null`). */
  shiftList: (period: { from: string; to: string } | null) => [
    "office",
    "shifts",
    period?.from ?? null,
    period?.to ?? null,
  ],
  /** One shift with its figures (`GET /v1/office/shifts/{id}`), read afresh at every opening. */
  shift: (id: string) => ["office", "shift", id],
  /** What a shift's exports are built from (`GET /v1/office/shifts/{id}/export-source`, plan ЧЗ). */
  shiftExportSource: (id: string) => ["office", "shift-export-source", id],
  /** A shift's pallets with what the station counted (`GET /v1/office/shifts/{id}/pallets`, plan ЧЗ). */
  shiftPallets: (id: string) => ["office", "shift-pallets", id],
  /** A shift's boxes for its card (`GET /v1/office/shifts/{id}/boxes`, plan О-Ф); the pallets are `shiftPallets`. */
  shiftBoxes: (id: string) => ["office", "shift-boxes", id],
  /** What a box's and a shift's pallets' forms print (`…/report-data`, plan О-Ф). */
  boxReport: (id: string) => ["office", "box-report", id],
  shiftPalletReport: (id: string) => ["office", "shift-pallet-report", id],
  /** One template with its layout (`GET /v1/office/templates/{id}`). */
  template: (id: string) => ["office", "template", id],
  /**
   * A template's layout for its thumbnail on «Шаблоны»: one revision of it,
   * which no write changes (each write gives a new revision).
   */
  templateLayout: (id: string, rev: number) => ["office", "template-layout", id, rev],
} as const;

/**
 * One cache per office session: `Office` creates it on mount, and `App`
 * remounts `Office` for every session, so no data outlives its session.
 * A host error is an answer, not a flake: the page explains it and offers
 * a retry, so nothing retries on its own. Calls go over IPC to the host,
 * and the webview's online flag says nothing about whether the host
 * answers: `networkMode: "always"` keeps queries and mutations running
 * (and erroring normally) instead of pausing silently when the OS reports
 * the webview offline.
 */
export function createOfficeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
        networkMode: "always",
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}

export interface OfficeQueryOptions {
  /** Read again every this many milliseconds while mounted; never by default. */
  refetchInterval?: number;
  /**
   * How long an answer stays fresh: 0 by default, so a page reads again
   * whenever it opens; `Infinity` for data that never changes in a session.
   */
  staleTime?: number;
  /** Whether to read at all; `true` by default. A read held back keeps what is cached. */
  enabled?: boolean;
}

/** Reads office data through `session.call`. */
export function useOfficeQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string) => Promise<T>,
  options: OfficeQueryOptions = {},
): UseQueryResult<T, Error> {
  const { api, call } = useOfficeSession();
  return useQuery({
    queryKey: key,
    queryFn: () => call((token) => read(api, token)),
    refetchInterval: options.refetchInterval ?? false,
    staleTime: options.staleTime ?? 0,
    enabled: options.enabled ?? true,
  });
}

/** Writes office data through `session.call`. */
export function useOfficeMutation<V, T>(
  write: (api: HostApi, token: string, variables: V) => Promise<T>,
): UseMutationResult<T, Error, V> {
  const { api, call } = useOfficeSession();
  return useMutation({
    mutationFn: (variables: V) => call((token) => write(api, token, variables)),
  });
}
