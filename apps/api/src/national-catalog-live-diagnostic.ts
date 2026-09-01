import { createDb, schema, type Db } from "@markiro/db";
import { and, asc, eq, gt } from "drizzle-orm";

import { loadEnv } from "./env";
import { NationalCatalogClient } from "./modules/national-catalog/national-catalog.client";
import type {
  NationalCatalogAuth,
  NationalCatalogResult,
  NationalCatalogRequestOptions,
} from "./modules/national-catalog/national-catalog.types";
import { ChzCryptoService } from "./modules/signer-agents/chz-crypto.service";

const PRODUCTION_NATIONAL_CATALOG_BASE_URL = "https://апи.национальный-каталог.рф";
type MethodName =
  "categories" | "categories-repeat" | "attributes" | "feed-product" | "product" | "product-repeat";
type Outcome = NationalCatalogResult<unknown>["status"];

export interface NationalCatalogDiagnosticCheck {
  method: MethodName;
  outcome: Outcome;
  resultCount: number;
  etagPresent: boolean;
}

export interface NationalCatalogDiagnosticEvidence {
  version: 1;
  passed: boolean;
  checks: NationalCatalogDiagnosticCheck[];
}

type SourceResult =
  | { status: "ok"; auth: NationalCatalogAuth; gtin: string }
  | { status: "unavailable" | "ambiguous" };

export interface NationalCatalogDiagnosticClient {
  listCategories(
    auth: NationalCatalogAuth,
    options?: NationalCatalogRequestOptions,
  ): Promise<NationalCatalogResult<{ categories: readonly unknown[] }>>;
  getAttributes(
    auth: NationalCatalogAuth,
  ): Promise<NationalCatalogResult<{ attributes: readonly unknown[] }>>;
  getFeedProducts(
    auth: NationalCatalogAuth,
    gtins: string[],
  ): Promise<NationalCatalogResult<{ products: readonly unknown[] }>>;
  getPublishedProducts(
    auth: NationalCatalogAuth,
    gtins: string[],
    options?: NationalCatalogRequestOptions,
  ): Promise<NationalCatalogResult<{ products: readonly unknown[] }>>;
}

interface DiagnosticDependencies {
  loadSource: () => Promise<SourceResult>;
  client: NationalCatalogDiagnosticClient;
}

interface Writable {
  write(value: string): unknown;
}

interface CliOptions {
  collect?: () => Promise<NationalCatalogDiagnosticEvidence>;
  stdout?: Writable;
  stderr?: Writable;
}

function check(
  method: MethodName,
  result: NationalCatalogResult<unknown>,
  resultCount: number,
): NationalCatalogDiagnosticCheck {
  return {
    method,
    outcome: result.status,
    resultCount,
    etagPresent: result.status === "ok" && result.etag !== null,
  };
}

function evidence(
  checks: NationalCatalogDiagnosticCheck[],
  passed: boolean,
): NationalCatalogDiagnosticEvidence {
  return { version: 1, passed, checks };
}

export async function collectNationalCatalogLiveDiagnostic(
  dependencies: DiagnosticDependencies,
): Promise<NationalCatalogDiagnosticEvidence> {
  const source = await dependencies.loadSource();
  if (source.status !== "ok") throw new Error("National Catalog diagnostic source is unavailable");

  const checks: NationalCatalogDiagnosticCheck[] = [];
  const categories = await dependencies.client.listCategories(source.auth);
  checks.push(
    check(
      "categories",
      categories,
      categories.status === "ok" ? categories.value.categories.length : 0,
    ),
  );
  if (categories.status !== "ok" || categories.etag === null) return evidence(checks, false);

  const repeatedCategories = await dependencies.client.listCategories(source.auth, {
    ifNoneMatch: categories.etag,
  });
  checks.push(check("categories-repeat", repeatedCategories, 0));
  if (repeatedCategories.status !== "not_modified") return evidence(checks, false);

  const attributes = await dependencies.client.getAttributes(source.auth);
  checks.push(
    check(
      "attributes",
      attributes,
      attributes.status === "ok" ? attributes.value.attributes.length : 0,
    ),
  );
  if (attributes.status !== "ok") return evidence(checks, false);

  const feedProduct = await dependencies.client.getFeedProducts(source.auth, [source.gtin]);
  checks.push(
    check(
      "feed-product",
      feedProduct,
      feedProduct.status === "ok" ? feedProduct.value.products.length : 0,
    ),
  );
  if (feedProduct.status !== "ok") return evidence(checks, false);

  const product = await dependencies.client.getPublishedProducts(source.auth, [source.gtin]);
  checks.push(
    check("product", product, product.status === "ok" ? product.value.products.length : 0),
  );
  if (product.status !== "ok" || product.etag === null) return evidence(checks, false);

  const repeatedProduct = await dependencies.client.getPublishedProducts(
    source.auth,
    [source.gtin],
    { ifNoneMatch: product.etag },
  );
  checks.push(check("product-repeat", repeatedProduct, 0));
  return evidence(checks, repeatedProduct.status === "not_modified");
}

async function loadProductionSource(db: Db, encryptionKey: Buffer): Promise<SourceResult> {
  const tokenRows = await db
    .select({
      tenantId: schema.chzApiTokens.tenantId,
      encryptedToken: schema.chzApiTokens.encryptedToken,
      tokenNonce: schema.chzApiTokens.tokenNonce,
      tokenTag: schema.chzApiTokens.tokenTag,
    })
    .from(schema.chzApiTokens)
    .where(gt(schema.chzApiTokens.expiresAt, new Date()))
    .orderBy(asc(schema.chzApiTokens.tenantId))
    .limit(2);
  if (tokenRows.length === 0) return { status: "unavailable" };
  if (tokenRows.length !== 1) return { status: "ambiguous" };

  const tokenRow = tokenRows[0];
  if (!tokenRow) return { status: "unavailable" };
  const [product] = await db
    .select({ gtin: schema.products.gtin14 })
    .from(schema.products)
    .where(
      and(eq(schema.products.tenantId, tokenRow.tenantId), eq(schema.products.archived, false)),
    )
    .orderBy(asc(schema.products.gtin14))
    .limit(1);
  const gtin = product?.gtin.trim();
  if (!gtin || !/^\d{14}$/.test(gtin)) return { status: "unavailable" };

  let token: string;
  try {
    token = new ChzCryptoService(encryptionKey).decrypt(tokenRow.tenantId, tokenRow);
  } catch {
    return { status: "unavailable" };
  }
  return {
    status: "ok",
    auth: { baseUrl: PRODUCTION_NATIONAL_CATALOG_BASE_URL, token },
    gtin,
  };
}

async function collectProductionEvidence(): Promise<NationalCatalogDiagnosticEvidence> {
  const env = loadEnv();
  const encryptionKey = env.CHZ_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) throw new Error("National Catalog diagnostic source is unavailable");
  const connection = createDb(env.DATABASE_URL);
  try {
    return await collectNationalCatalogLiveDiagnostic({
      loadSource: () => loadProductionSource(connection.db, encryptionKey),
      client: new NationalCatalogClient(undefined, env.NATIONAL_CATALOG_REQUEST_TIMEOUT_MS),
    });
  } finally {
    await connection.pool.end();
  }
}

export async function runNationalCatalogLiveDiagnosticCli(
  options: CliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  try {
    const result = await (options.collect ?? collectProductionEvidence)();
    stdout.write(`MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS ${JSON.stringify(result)}\n`);
    // The host-side wrapper validates the closed schema and turns passed=false
    // into the workflow failure. Returning zero here preserves the bounded
    // stdout when the provider refuses a documented read.
    return 0;
  } catch {
    stderr.write("MARKIRO_NATIONAL_CATALOG_DIAGNOSTICS_FAILURE\n");
    return 1;
  }
}

if (require.main === module) {
  void runNationalCatalogLiveDiagnosticCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
