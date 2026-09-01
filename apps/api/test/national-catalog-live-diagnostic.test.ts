import { describe, expect, it } from "vitest";

import {
  collectNationalCatalogLiveDiagnostic,
  runNationalCatalogLiveDiagnosticCli,
  type NationalCatalogDiagnosticClient,
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
