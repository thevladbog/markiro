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
  sscc: ["office", "sscc"],
  users: ["office", "users"],
} as const;

/**
 * One cache per office session: `Office` creates it on mount, and `App`
 * remounts `Office` for every session, so no data outlives its session.
 * A host error is an answer, not a flake: the page explains it and offers
 * a retry, so nothing retries on its own.
 */
export function createOfficeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

/** Reads office data through `session.call`. */
export function useOfficeQuery<T>(
  key: QueryKey,
  read: (api: HostApi, token: string) => Promise<T>,
): UseQueryResult<T, Error> {
  const { api, call } = useOfficeSession();
  return useQuery({ queryKey: key, queryFn: () => call((token) => read(api, token)) });
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
