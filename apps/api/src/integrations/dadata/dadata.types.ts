import type {
  DadataAddressSuggestion,
  DadataBankSuggestion,
  DadataOrganizationSuggestion,
  DadataSuggestionStatus,
} from "@markiro/platform-contracts";

export type DadataSuggestionKind = "organization" | "address" | "bank";

export interface DadataSuggestionResult<T> {
  status: DadataSuggestionStatus;
  items: T[];
}

export type DadataOrganizationResult = DadataSuggestionResult<DadataOrganizationSuggestion>;
export type DadataAddressResult = DadataSuggestionResult<DadataAddressSuggestion>;
export type DadataBankResult = DadataSuggestionResult<DadataBankSuggestion>;

export interface DadataClientDependencies {
  fetch: typeof fetch;
  scheduleAbort: (controller: AbortController, timeoutMs: number) => () => void;
}

export class DadataConfig {
  readonly #token: string | undefined;
  readonly #secret: string | undefined;

  constructor(token: string | undefined, secret: string | undefined) {
    this.#token = token;
    this.#secret = secret;
  }

  get configured(): boolean {
    return Boolean(this.#token);
  }

  get token(): string | undefined {
    return this.#token;
  }

  get secret(): string | undefined {
    return this.#secret;
  }

  toJSON(): { configured: boolean } {
    return { configured: this.configured };
  }
}

export const productionDadataClientDependencies: DadataClientDependencies = {
  fetch: globalThis.fetch.bind(globalThis),
  scheduleAbort: (controller, timeoutMs) => {
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    return () => clearTimeout(timeout);
  },
};
