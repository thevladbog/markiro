import type {
  DadataAddressSuggestion,
  DadataBankSuggestion,
  DadataOrganizationSuggestion,
} from "@markiro/platform-contracts";

import type { DadataCache } from "./dadata-cache";
import {
  mapDadataAddressSuggestions,
  mapDadataBankSuggestions,
  mapDadataOrganizationSuggestions,
} from "./dadata.mapper";
import {
  type DadataAddressResult,
  type DadataBankResult,
  type DadataClientDependencies,
  type DadataConfig,
  type DadataOrganizationResult,
  productionDadataClientDependencies,
} from "./dadata.types";

const BASE_URL = "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest";
const REQUEST_TIMEOUT_MS = 2_000;

export class DadataClient {
  constructor(
    private readonly config: DadataConfig,
    private readonly cache: DadataCache,
    private readonly dependencies: DadataClientDependencies = productionDadataClientDependencies,
  ) {}

  suggestOrganizations(query: string): Promise<DadataOrganizationResult> {
    return this.suggest("organization", "party", query, mapDadataOrganizationSuggestions);
  }

  suggestAddresses(query: string): Promise<DadataAddressResult> {
    return this.suggest("address", "address", query, mapDadataAddressSuggestions);
  }

  suggestBanks(query: string): Promise<DadataBankResult> {
    return this.suggest("bank", "bank", query, mapDadataBankSuggestions);
  }

  private async suggest<
    T extends DadataOrganizationSuggestion | DadataAddressSuggestion | DadataBankSuggestion,
  >(
    kind: "organization" | "address" | "bank",
    providerKind: "party" | "address" | "bank",
    rawQuery: string,
    mapper: (payload: unknown) => T[] | null,
  ): Promise<{ status: "ready" | "unconfigured" | "unavailable" | "no_results"; items: T[] }> {
    const query = rawQuery.trim().replace(/\s+/g, " ");
    if (query.length > 300) throw new RangeError("DaData query exceeds 300 characters");
    if (!query) return { status: "no_results", items: [] };
    if (!this.config.token) return { status: "unconfigured", items: [] };
    const cacheKey = `${kind}:${query.toLocaleLowerCase("ru-RU")}`;
    const cached = this.cache.get<T>(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const cancelAbort = this.dependencies.scheduleAbort(controller, REQUEST_TIMEOUT_MS);
    try {
      const response = await this.dependencies.fetch(`${BASE_URL}/${providerKind}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Token ${this.config.token}`,
        },
        body: JSON.stringify({ query, count: 10 }),
        signal: controller.signal,
      });
      if (!response.ok) return { status: "unavailable", items: [] };
      const items = mapper(await response.json());
      if (!items) return { status: "unavailable", items: [] };
      if (items.length === 0) return { status: "no_results", items: [] };
      const result = { status: "ready" as const, items };
      this.cache.set(cacheKey, result);
      return result;
    } catch {
      return { status: "unavailable", items: [] };
    } finally {
      cancelAbort();
    }
  }
}
