import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import {
  dadataAddressResultSchema,
  dadataBankResultSchema,
  dadataOrganizationResultSchema,
  dadataStatusResponseSchema,
  platformCommercialContracts,
  type DadataAddressSuggestion,
  type DadataBankSuggestion,
  type DadataOrganizationSuggestion,
  type DadataSuggestionStatus,
} from "@markiro/platform-contracts";
import type { z } from "zod";

import { platformApiFetch } from "../../api/client.js";

type SuggestionKind = "organizations" | "addresses" | "banks";

interface SuggestionTypes {
  organizations: DadataOrganizationSuggestion;
  addresses: DadataAddressSuggestion;
  banks: DadataBankSuggestion;
}

type SuggestionResult<T> = { status: DadataSuggestionStatus; items: T[] };

const resultSchemas = {
  organizations: dadataOrganizationResultSchema,
  addresses: dadataAddressResultSchema,
  banks: dadataBankResultSchema,
} satisfies Record<SuggestionKind, z.ZodType>;

export async function getDadataStatus() {
  return platformApiFetch("/suggestions/status", {
    responseSchema: dadataStatusResponseSchema,
  });
}

export async function getDadataSuggestions<K extends SuggestionKind>(
  kind: K,
  query: string,
  signal?: AbortSignal,
): Promise<SuggestionResult<SuggestionTypes[K]>> {
  const q = platformCommercialContracts.dadata[kind].query.parse({ q: query }).q;
  return platformApiFetch(`/suggestions/${kind}?${new URLSearchParams({ q })}`, {
    responseSchema: resultSchemas[kind],
    ...(signal ? { signal } : {}),
  }) as Promise<SuggestionResult<SuggestionTypes[K]>>;
}

export function useDadataSuggestions<K extends SuggestionKind>(
  kind: K,
  value: string,
  exactPattern?: RegExp,
) {
  const queryClient = useQueryClient();
  const normalized = useMemo(() => value.trim().replace(/\s+/g, " "), [value]);
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    void queryClient.cancelQueries({ queryKey: ["platform", "suggestions", kind] });
    if (normalized.length < 3 || normalized.length > 300) {
      setDebounced("");
      return;
    }
    if (exactPattern?.test(normalized)) {
      setDebounced(normalized);
      return;
    }
    const timer = window.setTimeout(() => setDebounced(normalized), 250);
    return () => window.clearTimeout(timer);
  }, [exactPattern, kind, normalized, queryClient]);

  return useQuery({
    queryKey: ["platform", "suggestions", kind, debounced],
    queryFn: ({ signal }) => getDadataSuggestions(kind, debounced, signal),
    enabled: debounced.length >= 3,
    staleTime: 15 * 60_000,
  });
}
