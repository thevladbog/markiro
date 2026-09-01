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
export type NationalCatalogDiagnosticSourceStatus =
  | "ready"
  | "encryption-key-missing"
  | "active-token-query-failed"
  | "active-token-missing"
  | "active-token-ambiguous"
  | "product-query-failed"
  | "product-gtin-unavailable"
  | "token-decryption-failed";
type UnavailableSourceStatus = Exclude<NationalCatalogDiagnosticSourceStatus, "ready">;

export interface NationalCatalogDiagnosticCheck {
  method: MethodName;
  outcome: Outcome;
  resultCount: number;
  etagPresent: boolean;
}

export interface NationalCatalogDiagnosticEvidence {
  version: 2;
  passed: boolean;
  sourceStatus: NationalCatalogDiagnosticSourceStatus;
  checks: NationalCatalogDiagnosticCheck[];
}

type SourceResult =
  | { status: "ok"; auth: NationalCatalogAuth; gtin: string }
  | { status: "unavailable"; sourceStatus: UnavailableSourceStatus };

export interface NationalCatalogProductionTokenCandidate {
  tenantId: string;
  encryptedToken: Buffer;
  tokenNonce: Buffer;
  tokenTag: Buffer;
}

interface NationalCatalogProductionSourceDependencies {
  listActiveTokens: () => Promise<readonly NationalCatalogProductionTokenCandidate[]>;
  findProductGtin: (tenantId: string) => Promise<string | null>;
  decryptToken: (tenantId: string, token: NationalCatalogProductionTokenCandidate) => string;
}

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
  sourceStatus: NationalCatalogDiagnosticSourceStatus = "ready",
): NationalCatalogDiagnosticEvidence {
  return { version: 2, passed, sourceStatus, checks };
}

export async function collectNationalCatalogLiveDiagnostic(
  dependencies: DiagnosticDependencies,
): Promise<NationalCatalogDiagnosticEvidence> {
  const source = await dependencies.loadSource();
  if (source.status !== "ok") return evidence([], false, source.sourceStatus);

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
  const feedProductCount = feedProduct.status === "ok" ? feedProduct.value.products.length : 0;
  checks.push(check("feed-product", feedProduct, feedProductCount));
  if (feedProduct.status !== "ok" || feedProductCount !== 1) return evidence(checks, false);

  const product = await dependencies.client.getPublishedProducts(source.auth, [source.gtin]);
  const productCount = product.status === "ok" ? product.value.products.length : 0;
  checks.push(check("product", product, productCount));
  if (product.status !== "ok" || productCount !== 1 || product.etag === null)
    return evidence(checks, false);

  const repeatedProduct = await dependencies.client.getPublishedProducts(
    source.auth,
    [source.gtin],
    { ifNoneMatch: product.etag },
  );
  checks.push(check("product-repeat", repeatedProduct, 0));
  return evidence(checks, repeatedProduct.status === "not_modified");
}

export async function loadNationalCatalogProductionSource(
  dependencies: NationalCatalogProductionSourceDependencies,
): Promise<SourceResult> {
  let tokenRows: readonly NationalCatalogProductionTokenCandidate[];
  try {
    tokenRows = await dependencies.listActiveTokens();
  } catch {
    return { status: "unavailable", sourceStatus: "active-token-query-failed" };
  }
  if (tokenRows.length === 0)
    return { status: "unavailable", sourceStatus: "active-token-missing" };
  if (tokenRows.length !== 1)
    return { status: "unavailable", sourceStatus: "active-token-ambiguous" };

  const tokenRow = tokenRows[0];
  if (!tokenRow) return { status: "unavailable", sourceStatus: "active-token-missing" };
  let productGtin: string | null;
  try {
    productGtin = await dependencies.findProductGtin(tokenRow.tenantId);
  } catch {
    return { status: "unavailable", sourceStatus: "product-query-failed" };
  }
  const gtin = productGtin?.trim();
  if (!gtin || !/^\d{14}$/.test(gtin))
    return { status: "unavailable", sourceStatus: "product-gtin-unavailable" };

  let token: string;
  try {
    token = dependencies.decryptToken(tokenRow.tenantId, tokenRow);
  } catch {
    return { status: "unavailable", sourceStatus: "token-decryption-failed" };
  }
  if (!token) return { status: "unavailable", sourceStatus: "token-decryption-failed" };
  return {
    status: "ok",
    auth: { baseUrl: PRODUCTION_NATIONAL_CATALOG_BASE_URL, token },
    gtin,
  };
}

function productionSourceDependencies(
  db: Db,
  encryptionKey: Buffer,
): NationalCatalogProductionSourceDependencies {
  const crypto = new ChzCryptoService(encryptionKey);
  return {
    listActiveTokens: () =>
      db
        .select({
          tenantId: schema.chzApiTokens.tenantId,
          encryptedToken: schema.chzApiTokens.encryptedToken,
          tokenNonce: schema.chzApiTokens.tokenNonce,
          tokenTag: schema.chzApiTokens.tokenTag,
        })
        .from(schema.chzApiTokens)
        .where(gt(schema.chzApiTokens.expiresAt, new Date()))
        .orderBy(asc(schema.chzApiTokens.tenantId))
        .limit(2),
    findProductGtin: async (tenantId) => {
      const [product] = await db
        .select({ gtin: schema.products.gtin14 })
        .from(schema.products)
        .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.archived, false)))
        .orderBy(asc(schema.products.gtin14))
        .limit(1);
      return product?.gtin ?? null;
    },
    decryptToken: (tenantId, token) => crypto.decrypt(tenantId, token),
  };
}

async function collectProductionEvidence(): Promise<NationalCatalogDiagnosticEvidence> {
  const env = loadEnv();
  const encryptionKey = env.CHZ_TOKEN_ENCRYPTION_KEY;
  if (!encryptionKey) return evidence([], false, "encryption-key-missing");
  const connection = createDb(env.DATABASE_URL);
  try {
    return await collectNationalCatalogLiveDiagnostic({
      loadSource: () =>
        loadNationalCatalogProductionSource(
          productionSourceDependencies(connection.db, encryptionKey),
        ),
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
    // The host-side wrapper preserves stdout for exit one, validates the
    // closed schema, and requires the exit code to match this result.
    return result.passed ? 0 : 1;
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
