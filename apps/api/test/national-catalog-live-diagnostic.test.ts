import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  collectNationalCatalogLiveDiagnostic,
  evaluateNationalCatalogDiagnostic,
  loadNationalCatalogProductionSource,
  runNationalCatalogLiveDiagnosticCli,
  type NationalCatalogDiagnosticClient,
  type NationalCatalogDiagnosticEvidence,
  type NationalCatalogDiagnosticObservation,
  type NationalCatalogProductionTokenCandidate,
} from "../src/national-catalog-live-diagnostic";
import type { NationalCatalogResult } from "../src/modules/national-catalog/national-catalog.types";

const PRIVATE_TOKEN = "private-bearer-token";
const PRIVATE_GTIN = "04601234567890";
const PRIVATE_PROVIDER_MESSAGE = "private-provider-message";
const PRESENT_USAGE = {
  total: { used: 1, limit: 500 },
  method: { used: 1, limit: 10 },
} as const;

function source() {
  return {
    status: "ok" as const,
    auth: { baseUrl: "https://catalog.example", token: PRIVATE_TOKEN },
    gtin: PRIVATE_GTIN,
  };
}

function ok<T>(
  value: T,
  options: { etag?: string | null; hash?: string; usage?: typeof PRESENT_USAGE } = {},
): NationalCatalogResult<T> {
  return {
    status: "ok",
    value,
    etag: options.etag ?? null,
    contentHash: options.hash ?? "stable-hash",
    usage: options.usage ?? PRESENT_USAGE,
  };
}

function successfulClient(
  calls: string[],
  overrides: Partial<NationalCatalogDiagnosticClient> = {},
): NationalCatalogDiagnosticClient {
  return {
    listCategories:
      overrides.listCategories ??
      (async (_auth, options = {}) => {
        calls.push(options.ifNoneMatch ? "categories-repeat-conditional" : "categories");
        return options.ifNoneMatch
          ? { status: "not_modified" }
          : ok({ categories: [{ id: 1 }] }, { etag: '"categories-etag"', hash: "categories" });
      }),
    getAttributes:
      overrides.getAttributes ??
      (async () => {
        calls.push("attributes");
        return ok({ attributes: [{ id: 2 }] }, { hash: "attributes" });
      }),
    getFeedProducts:
      overrides.getFeedProducts ??
      (async (_auth, gtins) => {
        calls.push(`feed-product:${gtins.join(",")}`);
        return ok({ products: [{ id: 3 }] }, { hash: "feed-product" });
      }),
    getPublishedProducts:
      overrides.getPublishedProducts ??
      (async (_auth, gtins, options = {}) => {
        calls.push(
          options.ifNoneMatch ? "product-repeat-conditional" : `product:${gtins.join(",")}`,
        );
        return options.ifNoneMatch
          ? { status: "not_modified" }
          : ok({ products: [{ id: 4 }] }, { etag: '"product-etag"', hash: "product" });
      }),
  };
}

function observation(
  method: NationalCatalogDiagnosticObservation["method"],
  outcome: NationalCatalogDiagnosticObservation["outcome"] = "ok",
  options: Partial<Omit<NationalCatalogDiagnosticObservation, "method" | "outcome">> = {},
): NationalCatalogDiagnosticObservation {
  return {
    method,
    outcome,
    resultCount: options.resultCount ?? (outcome === "ok" ? 1 : 0),
    etagPresent: options.etagPresent ?? false,
    contentHash: options.contentHash ?? (outcome === "ok" ? `${method}-hash` : null),
    usagePresent: options.usagePresent ?? outcome === "ok",
  };
}

function conformantObservations(): NationalCatalogDiagnosticObservation[] {
  return [
    observation("categories", "ok", { etagPresent: true, contentHash: "categories" }),
    observation("categories-repeat", "not_modified"),
    observation("attributes"),
    observation("feed-product"),
    observation("product", "ok", { etagPresent: true, contentHash: "product" }),
    observation("product-repeat", "not_modified"),
  ];
}

describe("National Catalog diagnostic v3 evaluator", () => {
  it("accepts ETag plus 304 as a conformant operational result", () => {
    expect(evaluateNationalCatalogDiagnostic("ready", conformantObservations())).toMatchObject({
      version: 3,
      passed: true,
      contractStatus: "conformant",
      capabilities: {
        schemaRead: "available",
        ownedCardRead: "available",
        publishedCardRead: "available",
      },
      violations: [],
    });
  });

  it.each([
    {
      label: "missing ETag with an equal repeat hash",
      first: observation("categories", "ok", { etagPresent: false, contentHash: "same" }),
      repeat: observation("categories-repeat", "ok", { contentHash: "same" }),
    },
    {
      label: "ETag with an unchanged 200 repeat",
      first: observation("categories", "ok", { etagPresent: true, contentHash: "same" }),
      repeat: observation("categories-repeat", "ok", { contentHash: "same" }),
    },
  ])("keeps $label operational but marks the provider contract degraded", ({ first, repeat }) => {
    const observations = conformantObservations();
    observations.splice(0, 2, first, repeat);
    const result = evaluateNationalCatalogDiagnostic("ready", observations);
    expect(result).toMatchObject({
      passed: true,
      contractStatus: "degraded",
      capabilities: { schemaRead: "available" },
    });
    expect(result.checks[1]?.cacheObservation).toBe("same_hash");
    expect(result.violations).toContainEqual({
      capability: "schema_read",
      code: "cache_contract_degraded",
    });
  });

  it.each([
    ["changed hash", observation("categories-repeat", "ok", { contentHash: "changed" })],
    ["not found", observation("categories-repeat", "not_found")],
    ["unauthorized", observation("categories-repeat", "unauthorized")],
    ["forbidden", observation("categories-repeat", "forbidden")],
    ["rate limited", observation("categories-repeat", "rate_limited")],
    ["invalid response", observation("categories-repeat", "invalid_response")],
    ["unavailable", observation("categories-repeat", "unavailable")],
  ] as const)("fails schema capability when the category repeat is %s", (_label, repeat) => {
    const observations = conformantObservations();
    observations.splice(0, 2, observation("categories", "ok", { contentHash: "original" }), repeat);
    const result = evaluateNationalCatalogDiagnostic("ready", observations);
    expect(result).toMatchObject({
      passed: false,
      capabilities: { schemaRead: "unavailable" },
    });
    expect(result.violations).toEqual(
      expect.arrayContaining([
        { capability: "schema_read", code: "schema_read_failed" },
        { capability: "schema_read", code: "cache_contract_degraded" },
      ]),
    );
  });

  it.each([
    ["changed hash", observation("product-repeat", "ok", { contentHash: "changed" })],
    ["not found", observation("product-repeat", "not_found")],
    ["unauthorized", observation("product-repeat", "unauthorized")],
    ["forbidden", observation("product-repeat", "forbidden")],
    ["rate limited", observation("product-repeat", "rate_limited")],
    ["invalid response", observation("product-repeat", "invalid_response")],
    ["unavailable", observation("product-repeat", "unavailable")],
  ] as const)(
    "removes only the published capability when the product repeat is %s",
    (_label, repeat) => {
      const observations = conformantObservations();
      observations.splice(4, 2, observation("product", "ok", { contentHash: "original" }), repeat);
      const result = evaluateNationalCatalogDiagnostic("ready", observations);
      expect(result).toMatchObject({
        passed: true,
        capabilities: { ownedCardRead: "available", publishedCardRead: "unavailable" },
      });
      expect(result.violations).toEqual(
        expect.arrayContaining([
          { capability: "published_card_read", code: "published_card_read_failed" },
          { capability: "published_card_read", code: "cache_contract_degraded" },
        ]),
      );
    },
  );

  it.each([
    {
      label: "private only",
      feed: observation("feed-product"),
      product: observation("product", "not_found"),
      expected: { ownedCardRead: "available", publishedCardRead: "unavailable" },
    },
    {
      label: "published only",
      feed: observation("feed-product", "not_found"),
      product: observation("product", "ok", { resultCount: 1 }),
      expected: { ownedCardRead: "unavailable", publishedCardRead: "available" },
    },
    {
      label: "both valid but empty",
      feed: observation("feed-product", "ok", { resultCount: 0 }),
      product: observation("product", "ok", { resultCount: 0 }),
      expected: { ownedCardRead: "available", publishedCardRead: "available" },
    },
  ])("treats $label card visibility as independent capabilities", ({ feed, product, expected }) => {
    const result = evaluateNationalCatalogDiagnostic("ready", [
      observation("categories", "ok", { etagPresent: true }),
      observation("categories-repeat", "not_modified"),
      observation("attributes"),
      feed,
      product,
      ...(product.outcome === "ok"
        ? [
            observation("product-repeat", "ok", {
              contentHash: product.contentHash,
            }),
          ]
        : []),
    ]);
    expect(result.passed).toBe(true);
    expect(result.capabilities).toMatchObject(expected);
  });

  it.each([
    "unauthorized",
    "forbidden",
    "rate_limited",
    "invalid_response",
    "unavailable",
  ] as const)(
    "classifies %s per card capability without hiding the independent published read",
    (outcome) => {
      const result = evaluateNationalCatalogDiagnostic("ready", [
        observation("categories", "ok", { etagPresent: true }),
        observation("categories-repeat", "not_modified"),
        observation("attributes"),
        observation("feed-product", outcome),
        observation("product"),
        observation("product-repeat", "ok", { contentHash: "product-hash" }),
      ]);
      expect(result).toMatchObject({
        passed: true,
        capabilities: { ownedCardRead: "unavailable", publishedCardRead: "available" },
      });
    },
  );

  it("fails operationally when either schema read is invalid", () => {
    const result = evaluateNationalCatalogDiagnostic("ready", [
      observation("categories", "invalid_response"),
      observation("attributes"),
      observation("feed-product"),
      observation("product"),
    ]);
    expect(result).toMatchObject({ passed: false, capabilities: { schemaRead: "unavailable" } });
  });

  it("keeps valid reads operational when usage headers are absent and records degradation", () => {
    const observations = conformantObservations();
    observations[2] = observation("attributes", "ok", { usagePresent: false });
    const result = evaluateNationalCatalogDiagnostic("ready", observations);
    expect(result).toMatchObject({ passed: true, contractStatus: "degraded" });
    expect(result.checks[2]).toMatchObject({ method: "attributes", usagePresent: false });
    expect(result.violations).toContainEqual({
      capability: "schema_read",
      code: "usage_headers_missing",
    });
  });

  it("returns closed no-provider evidence for a source acquisition failure", () => {
    expect(evaluateNationalCatalogDiagnostic("active-token-missing", [])).toEqual({
      version: 3,
      passed: false,
      sourceStatus: "active-token-missing",
      contractStatus: "degraded",
      capabilities: {
        schemaRead: "not_checked",
        ownedCardRead: "not_checked",
        publishedCardRead: "not_checked",
      },
      checks: [],
      violations: [{ capability: "source", code: "source_unavailable" }],
    });
  });
});

describe("National Catalog diagnostic v3 collector", () => {
  it("collects independent phases and emits only bounded sanitized evidence", async () => {
    const calls: string[] = [];
    const evidence = await collectNationalCatalogLiveDiagnostic({
      loadSource: async () => source(),
      client: successfulClient(calls, {
        listCategories: async (_auth, options = {}) => {
          calls.push(options.ifNoneMatch ? "unexpected-conditional" : "categories");
          return ok(
            { categories: [{ private: PRIVATE_PROVIDER_MESSAGE }] },
            { etag: null, hash: "categories-fallback" },
          );
        },
        getFeedProducts: async () => {
          calls.push("feed-product");
          return { status: "forbidden", message: PRIVATE_PROVIDER_MESSAGE };
        },
      }),
    });

    expect(calls).toEqual([
      "categories",
      "categories",
      "attributes",
      "feed-product",
      `product:${PRIVATE_GTIN}`,
      "product-repeat-conditional",
    ]);
    expect(evidence).toMatchObject({
      version: 3,
      passed: true,
      contractStatus: "degraded",
      capabilities: {
        schemaRead: "available",
        ownedCardRead: "unavailable",
        publishedCardRead: "available",
      },
    });
    const serialized = JSON.stringify(evidence);
    for (const sentinel of [
      PRIVATE_TOKEN,
      PRIVATE_GTIN,
      PRIVATE_PROVIDER_MESSAGE,
      "catalog.example",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
  });

  it("does not repeat a failed read and keeps feed and published reads independent", async () => {
    const calls: string[] = [];
    const evidence = await collectNationalCatalogLiveDiagnostic({
      loadSource: async () => source(),
      client: successfulClient(calls, {
        listCategories: async () => {
          calls.push("categories");
          return { status: "unavailable" };
        },
        getFeedProducts: async () => {
          calls.push("feed-product");
          return { status: "unauthorized" };
        },
      }),
    });
    expect(calls).toEqual([
      "categories",
      "attributes",
      "feed-product",
      `product:${PRIVATE_GTIN}`,
      "product-repeat-conditional",
    ]);
    expect(evidence).toMatchObject({
      passed: false,
      capabilities: {
        schemaRead: "unavailable",
        ownedCardRead: "unavailable",
        publishedCardRead: "available",
      },
    });
  });
});

describe("National Catalog production source", () => {
  it("resolves the product and token with the same selected tenant identity", async () => {
    const token: NationalCatalogProductionTokenCandidate = {
      tenantId: "tenant-a",
      encryptedToken: Buffer.from("encrypted"),
      tokenNonce: Buffer.from("nonce"),
      tokenTag: Buffer.from("tag"),
    };
    const calls: string[] = [];
    const result = await loadNationalCatalogProductionSource({
      listActiveTokens: async () => [token],
      findProductGtin: async (tenantId) => {
        calls.push(`product:${tenantId}`);
        return PRIVATE_GTIN;
      },
      decryptToken: (tenantId, candidate) => {
        calls.push(`decrypt:${tenantId}`);
        expect(candidate).toBe(token);
        return PRIVATE_TOKEN;
      },
    });
    expect(calls).toEqual(["product:tenant-a", "decrypt:tenant-a"]);
    expect(result).toEqual({
      status: "ok",
      auth: { baseUrl: "https://апи.национальный-каталог.рф", token: PRIVATE_TOKEN },
      gtin: PRIVATE_GTIN,
    });
  });

  it("fails closed before product or crypto work for zero or ambiguous token tenants", async () => {
    const token = {
      tenantId: "tenant-a",
      encryptedToken: Buffer.alloc(1),
      tokenNonce: Buffer.alloc(1),
      tokenTag: Buffer.alloc(1),
    };
    for (const [tokens, expected] of [
      [[], "active-token-missing"],
      [[token, { ...token, tenantId: "tenant-b" }], "active-token-ambiguous"],
    ] as const) {
      const calls: string[] = [];
      const result = await loadNationalCatalogProductionSource({
        listActiveTokens: async () => tokens,
        findProductGtin: async () => {
          calls.push("product");
          return PRIVATE_GTIN;
        },
        decryptToken: () => {
          calls.push("decrypt");
          return PRIVATE_TOKEN;
        },
      });
      expect(result).toEqual({ status: "unavailable", sourceStatus: expected });
      expect(calls).toEqual([]);
    }
  });

  it.each([
    ["active-token-query-failed", "tokens"],
    ["product-query-failed", "product"],
  ] as const)("returns bounded %s evidence", async (expected, failure) => {
    const privateError = `private-${failure}-database-detail`;
    const token = {
      tenantId: "tenant-a",
      encryptedToken: Buffer.alloc(1),
      tokenNonce: Buffer.alloc(1),
      tokenTag: Buffer.alloc(1),
    };
    const result = await loadNationalCatalogProductionSource({
      listActiveTokens: async () => {
        if (failure === "tokens") throw new Error(privateError);
        return [token];
      },
      findProductGtin: async () => {
        throw new Error(privateError);
      },
      decryptToken: () => PRIVATE_TOKEN,
    });
    expect(result).toEqual({ status: "unavailable", sourceStatus: expected });
    expect(JSON.stringify(result)).not.toContain(privateError);
  });

  it.each([null, "", "123", "0460123456789x"])(
    "fails closed for missing or invalid same-tenant GTIN %s without decrypting",
    async (gtin) => {
      let decrypted = false;
      const result = await loadNationalCatalogProductionSource({
        listActiveTokens: async () => [
          {
            tenantId: "tenant-a",
            encryptedToken: Buffer.alloc(1),
            tokenNonce: Buffer.alloc(1),
            tokenTag: Buffer.alloc(1),
          },
        ],
        findProductGtin: async () => gtin,
        decryptToken: () => {
          decrypted = true;
          return PRIVATE_TOKEN;
        },
      });
      expect(result).toEqual({
        status: "unavailable",
        sourceStatus: "product-gtin-unavailable",
      });
      expect(decrypted).toBe(false);
    },
  );

  it("fails closed when tenant-bound token decryption fails", async () => {
    const result = await loadNationalCatalogProductionSource({
      listActiveTokens: async () => [
        {
          tenantId: "tenant-a",
          encryptedToken: Buffer.alloc(1),
          tokenNonce: Buffer.alloc(1),
          tokenTag: Buffer.alloc(1),
        },
      ],
      findProductGtin: async () => PRIVATE_GTIN,
      decryptToken: () => {
        throw new Error("private crypto detail");
      },
    });
    expect(result).toEqual({ status: "unavailable", sourceStatus: "token-decryption-failed" });
  });
});

describe("National Catalog diagnostic CLI", () => {
  it("prints one canonical safe line and maps passed to the exit code", async () => {
    for (const passed of [true, false] as const) {
      let stdout = "";
      let stderr = "";
      const collected: NationalCatalogDiagnosticEvidence = passed
        ? evaluateNationalCatalogDiagnostic("ready", conformantObservations())
        : evaluateNationalCatalogDiagnostic("active-token-missing", []);
      const exitCode = await runNationalCatalogLiveDiagnosticCli({
        collect: async () => collected,
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
      });
      expect(exitCode).toBe(passed ? 0 : 1);
      expect(stdout).toBe(`MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(collected)}\n`);
      expect(stderr).toBe("");
    }
  });

  it("crosses the API-to-host boundary as v3 and rejects the former v2 contract", async () => {
    const moduleUrl = pathToFileURL(
      resolve(__dirname, "../../../deploy/yandex/national-catalog-diagnostics.mjs"),
    ).href;
    const { runHostedNationalCatalogDiagnostics } = (await import(moduleUrl)) as {
      runHostedNationalCatalogDiagnostics: (
        environment: Record<string, string>,
        supplied: Record<string, unknown>,
      ) => Promise<NationalCatalogDiagnosticEvidence>;
    };
    const environment = {
      YC_APP_PUBLIC_ADDRESS: "203.0.113.42",
      YC_APP_DEPLOY_LOGIN: "markiro-deploy",
      YC_APP_DEPLOY_SSH_PRIVATE_KEY_PATH: "/runner/private-key",
      APP_SSH_HOST_KEYS_B64: Buffer.from(
        `ssh-ed25519 ${Buffer.alloc(32, 1).toString("base64")}`,
      ).toString("base64"),
    };
    const evidence = evaluateNationalCatalogDiagnostic("ready", conformantObservations());
    const supplied = (value: unknown) => ({
      validatePrivateKey: async () => undefined,
      run: async () => "a1b2c3d4e5f6\n",
      runDiagnostic: async () => ({
        exitCode: 0,
        stdout: `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(value)}\n`,
      }),
      mkdtemp: async () => "/runner/national-catalog-known-hosts",
      writeFile: async () => undefined,
      rm: async () => undefined,
    });

    await expect(
      runHostedNationalCatalogDiagnostics(environment, supplied(evidence)),
    ).resolves.toEqual(evidence);
    await expect(
      runHostedNationalCatalogDiagnostics(environment, supplied({ ...evidence, version: 2 })),
    ).rejects.toThrow("National Catalog diagnostic response is invalid");
  });
});
