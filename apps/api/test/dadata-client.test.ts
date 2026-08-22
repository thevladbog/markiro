import { describe, expect, it, vi } from "vitest";

import { DadataCache } from "../src/integrations/dadata/dadata-cache";
import { DadataClient } from "../src/integrations/dadata/dadata.client";
import {
  DadataConfig,
  type DadataClientDependencies,
} from "../src/integrations/dadata/dadata.types";

function response(body: unknown, options: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function dependencies(fetchImplementation: typeof fetch): DadataClientDependencies {
  return {
    fetch: fetchImplementation,
    scheduleAbort: (controller, timeoutMs) => {
      expect(timeoutMs).toBe(2_000);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      return () => clearTimeout(timeout);
    },
  };
}

describe("DaData client", () => {
  it("returns unconfigured without making a provider request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new DadataClient(
      new DadataConfig(undefined, undefined),
      new DadataCache(() => 1_000),
      dependencies(fetchMock),
    );

    await expect(client.suggestBanks("044525225")).resolves.toEqual({
      status: "unconfigured",
      items: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes cache keys and caches only ready results for fifteen minutes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      response({
        suggestions: [
          {
            value: "ПАО Сбербанк",
            data: {
              bic: "044525225",
              correspondent_account: "30101810400000000225",
              name: { payment: "ПАО Сбербанк" },
            },
          },
        ],
      }),
    );
    let now = 1_000;
    const client = new DadataClient(
      new DadataConfig("provider-token", undefined),
      new DadataCache(() => now),
      dependencies(fetchMock),
    );

    const first = await client.suggestBanks("  СБЕРБАНК  ");
    now += 14 * 60_000;
    const cached = await client.suggestBanks("сбербанк");
    expect(first).toEqual(cached);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now += 2 * 60_000;
    await client.suggestBanks("сбербанк");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://suggestions.dadata.ru/suggestions/api/4_1/rs/suggest/bank",
    );
    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.headers).toEqual(
      expect.objectContaining({ Authorization: "Token provider-token" }),
    );
    expect(JSON.stringify(request)).not.toContain("provider-secret");
  });

  it.each([
    ["non-2xx", vi.fn<typeof fetch>(async () => response({}, { ok: false, status: 503 }))],
    [
      "malformed JSON",
      vi.fn<typeof fetch>(
        async () =>
          ({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError("malformed provider JSON");
            },
          }) as unknown as Response,
      ),
    ],
  ])("returns unavailable for %s responses", async (_label, fetchMock) => {
    const client = new DadataClient(
      new DadataConfig("provider-token", "provider-secret"),
      new DadataCache(() => 1_000),
      dependencies(fetchMock),
    );
    await expect(client.suggestAddresses("Москва")).resolves.toEqual({
      status: "unavailable",
      items: [],
    });
  });

  it("distinguishes a successful empty provider response", async () => {
    const client = new DadataClient(
      new DadataConfig("provider-token", undefined),
      new DadataCache(() => 1_000),
      dependencies(vi.fn<typeof fetch>(async () => response({ suggestions: [] }))),
    );
    await expect(client.suggestOrganizations("нет результатов")).resolves.toEqual({
      status: "no_results",
      items: [],
    });
  });

  it("refuses queries over the provider's 300-character boundary before fetch", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new DadataClient(
      new DadataConfig("provider-token", undefined),
      new DadataCache(() => 1_000),
      dependencies(fetchMock),
    );
    await expect(client.suggestAddresses("а".repeat(301))).rejects.toBeInstanceOf(RangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts provider work after two seconds and returns unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const client = new DadataClient(
      new DadataConfig("provider-token", undefined),
      new DadataCache(() => 1_000),
      {
        ...dependencies(fetchMock),
        scheduleAbort: (controller, timeoutMs) => {
          expect(timeoutMs).toBe(2_000);
          queueMicrotask(() => controller.abort());
          return () => undefined;
        },
      },
    );

    await expect(client.suggestOrganizations("Ромашка")).resolves.toEqual({
      status: "unavailable",
      items: [],
    });
  });
});
