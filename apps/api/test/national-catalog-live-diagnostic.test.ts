import { describe, expect, it } from "vitest";

import {
  collectNationalCatalogLiveDiagnostic,
  loadNationalCatalogProductionSource,
  runNationalCatalogLiveDiagnosticCli,
  type NationalCatalogDiagnosticClient,
  type NationalCatalogProductionTokenCandidate,
} from "../src/national-catalog-live-diagnostic";

const PRIVATE_TOKEN = "private-bearer-token";
const PRIVATE_GTIN = "04601234567890";

function source() {
  return {
    status: "ok" as const,
    auth: { baseUrl: "https://catalog.example", token: PRIVATE_TOKEN },
    gtin: PRIVATE_GTIN,
  };
}

function successfulClient(calls: string[]): NationalCatalogDiagnosticClient {
  return {
    listCategories: async (_auth: unknown, options: { ifNoneMatch?: string } = {}) => {
      calls.push(options.ifNoneMatch ? `categories:${options.ifNoneMatch}` : "categories");
      return options.ifNoneMatch
        ? ({ status: "not_modified" } as const)
        : ({
            status: "ok",
            value: { categories: [{ id: 1 }], raw: {} },
            etag: '"categories-etag"',
          } as const);
    },
    getAttributes: async () => {
      calls.push("attributes");
      return {
        status: "ok",
        value: { attributes: [{ id: 2 }], raw: {} },
        etag: null,
      } as const;
    },
    getFeedProducts: async (_auth: unknown, gtins: string[]) => {
      calls.push(`feed-product:${gtins.join(",")}`);
      return {
        status: "ok",
        value: { products: [{ id: 3 }], raw: {} },
        etag: null,
      } as const;
    },
    getPublishedProducts: async (
      _auth: unknown,
      gtins: string[],
      options: { ifNoneMatch?: string } = {},
    ) => {
      calls.push(
        options.ifNoneMatch
          ? `product:${gtins.join(",")}:${options.ifNoneMatch}`
          : `product:${gtins.join(",")}`,
      );
      return options.ifNoneMatch
        ? ({ status: "not_modified" } as const)
        : ({
            status: "ok",
            value: { products: [{ id: 4 }], raw: {} },
            etag: '"product-etag"',
          } as const);
    },
  };
}

describe("National Catalog production live diagnostic", () => {
  it("emits only bounded evidence for the six approved GET reads", async () => {
    const calls: string[] = [];
    const evidence = await collectNationalCatalogLiveDiagnostic({
      loadSource: async () => source(),
      client: successfulClient(calls),
    });

    expect(calls).toEqual([
      "categories",
      'categories:"categories-etag"',
      "attributes",
      `feed-product:${PRIVATE_GTIN}`,
      `product:${PRIVATE_GTIN}`,
      `product:${PRIVATE_GTIN}:"product-etag"`,
    ]);
    expect(evidence).toEqual({
      version: 1,
      passed: true,
      checks: [
        { method: "categories", outcome: "ok", resultCount: 1, etagPresent: true },
        {
          method: "categories-repeat",
          outcome: "not_modified",
          resultCount: 0,
          etagPresent: false,
        },
        { method: "attributes", outcome: "ok", resultCount: 1, etagPresent: false },
        { method: "feed-product", outcome: "ok", resultCount: 1, etagPresent: false },
        { method: "product", outcome: "ok", resultCount: 1, etagPresent: true },
        {
          method: "product-repeat",
          outcome: "not_modified",
          resultCount: 0,
          etagPresent: false,
        },
      ],
    });
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain(PRIVATE_TOKEN);
    expect(serialized).not.toContain(PRIVATE_GTIN);
    expect(serialized).not.toContain("catalog.example");
  });

  it("stops after the first provider refusal and reports no provider message", async () => {
    const calls: string[] = [];
    const client = successfulClient(calls);
    client.listCategories = async () => {
      calls.push("categories");
      return { status: "forbidden", message: "private provider detail" } as const;
    };

    const evidence = await collectNationalCatalogLiveDiagnostic({
      loadSource: async () => source(),
      client,
    });

    expect(calls).toEqual(["categories"]);
    expect(evidence).toEqual({
      version: 1,
      passed: false,
      checks: [{ method: "categories", outcome: "forbidden", resultCount: 0, etagPresent: false }],
    });
    expect(JSON.stringify(evidence)).not.toContain("private provider detail");
  });

  it.each([0, 2])(
    "fails closed when feed-product returns %i cards and does not continue",
    async (resultCount) => {
      const calls: string[] = [];
      const client = successfulClient(calls);
      client.getFeedProducts = async () => {
        calls.push("feed-product");
        return {
          status: "ok",
          value: { products: Array.from({ length: resultCount }, () => ({})), raw: {} },
          etag: null,
        } as const;
      };

      const result = await collectNationalCatalogLiveDiagnostic({
        loadSource: async () => source(),
        client,
      });

      expect(calls).toEqual([
        "categories",
        'categories:"categories-etag"',
        "attributes",
        "feed-product",
      ]);
      expect(result.passed).toBe(false);
      expect(result.checks.at(-1)).toEqual({
        method: "feed-product",
        outcome: "ok",
        resultCount,
        etagPresent: false,
      });
    },
  );

  it.each([0, 2])(
    "fails closed when product returns %i cards and does not request its ETag again",
    async (resultCount) => {
      const calls: string[] = [];
      const client = successfulClient(calls);
      client.getPublishedProducts = async () => {
        calls.push("product");
        return {
          status: "ok",
          value: { products: Array.from({ length: resultCount }, () => ({})), raw: {} },
          etag: '"product-etag"',
        } as const;
      };

      const result = await collectNationalCatalogLiveDiagnostic({
        loadSource: async () => source(),
        client,
      });

      expect(calls).toEqual([
        "categories",
        'categories:"categories-etag"',
        "attributes",
        `feed-product:${PRIVATE_GTIN}`,
        "product",
      ]);
      expect(result.passed).toBe(false);
      expect(result.checks.at(-1)).toEqual({
        method: "product",
        outcome: "ok",
        resultCount,
        etagPresent: true,
      });
    },
  );

  it.each(["unavailable", "ambiguous"] as const)(
    "makes no provider request when the source is %s",
    async (status) => {
      const calls: string[] = [];
      await expect(
        collectNationalCatalogLiveDiagnostic({
          loadSource: async () => ({ status }),
          client: successfulClient(calls),
        }),
      ).rejects.toThrow("National Catalog diagnostic source is unavailable");
      expect(calls).toEqual([]);
    },
  );

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
        return "04601234567890";
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
      auth: {
        baseUrl: "https://апи.национальный-каталог.рф",
        token: PRIVATE_TOKEN,
      },
      gtin: "04601234567890",
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
      [[], "unavailable"],
      [[token, { ...token, tenantId: "tenant-b" }], "ambiguous"],
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
      expect(result).toEqual({ status: expected });
      expect(calls).toEqual([]);
    }
  });

  it.each([null, "", "123", "0460123456789x"])(
    "fails closed for missing or invalid same-tenant GTIN %s without decrypting",
    async (gtin) => {
      const token = {
        tenantId: "tenant-a",
        encryptedToken: Buffer.alloc(1),
        tokenNonce: Buffer.alloc(1),
        tokenTag: Buffer.alloc(1),
      };
      let decrypted = false;
      const result = await loadNationalCatalogProductionSource({
        listActiveTokens: async () => [token],
        findProductGtin: async (tenantId) => {
          expect(tenantId).toBe("tenant-a");
          return gtin;
        },
        decryptToken: () => {
          decrypted = true;
          return PRIVATE_TOKEN;
        },
      });
      expect(result).toEqual({ status: "unavailable" });
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
      decryptToken: (tenantId) => {
        expect(tenantId).toBe("tenant-a");
        throw new Error("private crypto detail");
      },
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("CLI prints one canonical safe line for the host-side gate to evaluate", async () => {
    for (const passed of [true, false] as const) {
      let stdout = "";
      let stderr = "";
      const exitCode = await runNationalCatalogLiveDiagnosticCli({
        collect: async () => ({ version: 1, passed, checks: [] }),
        stdout: { write: (value: string) => (stdout += value) },
        stderr: { write: (value: string) => (stderr += value) },
      });
      expect(exitCode).toBe(0);
      expect(stdout).toBe(
        `MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify({ version: 1, passed, checks: [] })}\n`,
      );
      expect(stderr).toBe("");
    }
  });
});
