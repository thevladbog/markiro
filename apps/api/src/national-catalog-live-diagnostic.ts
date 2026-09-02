import { createDb, schema, type Db } from "@markiro/db";
import { and, asc, eq, gt } from "drizzle-orm";

import { loadEnv } from "./env";
import { NationalCatalogClient } from "./modules/national-catalog/national-catalog.client";
import type {
  NationalCatalogAttributesRequest,
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

type CapabilityState = "available" | "unavailable" | "not_checked";
type CapabilityName = "source" | "schema_read" | "owned_card_read" | "published_card_read";
type CacheObservation =
  "not_checked" | "etag_present" | "etag_missing" | "not_modified" | "same_hash" | "changed_hash";
type ViolationCode =
  | "source_unavailable"
  | "schema_read_failed"
  | "owned_card_read_failed"
  | "published_card_read_failed"
  | "cache_contract_degraded"
  | "usage_headers_missing";

export interface NationalCatalogDiagnosticObservation {
  method: MethodName;
  outcome: Outcome;
  resultCount: number;
  etagPresent: boolean;
  contentHash: string | null;
  usagePresent: boolean;
}

export interface NationalCatalogDiagnosticCheck {
  method: MethodName;
  outcome: Outcome;
  resultCount: number;
  cacheObservation: CacheObservation;
  usagePresent: boolean;
}

export interface NationalCatalogDiagnosticViolation {
  capability: CapabilityName;
  code: ViolationCode;
}

export interface NationalCatalogDiagnosticEvidence {
  version: 3;
  passed: boolean;
  sourceStatus: NationalCatalogDiagnosticSourceStatus;
  contractStatus: "conformant" | "degraded";
  capabilities: {
    schemaRead: CapabilityState;
    ownedCardRead: CapabilityState;
    publishedCardRead: CapabilityState;
  };
  checks: NationalCatalogDiagnosticCheck[];
  violations: NationalCatalogDiagnosticViolation[];
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
    options: NationalCatalogAttributesRequest,
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

function observation(
  method: MethodName,
  result: NationalCatalogResult<unknown>,
  resultCount: number,
): NationalCatalogDiagnosticObservation {
  return {
    method,
    outcome: result.status,
    resultCount,
    etagPresent: result.status === "ok" && result.etag !== null,
    contentHash: result.status === "ok" ? result.contentHash : null,
    usagePresent:
      result.status === "ok" && result.usage.total !== null && result.usage.method !== null,
  };
}

export function evaluateNationalCatalogDiagnostic(
  sourceStatus: NationalCatalogDiagnosticSourceStatus,
  observations: readonly NationalCatalogDiagnosticObservation[],
): NationalCatalogDiagnosticEvidence {
  if (sourceStatus !== "ready") {
    return {
      version: 3,
      passed: false,
      sourceStatus,
      contractStatus: "degraded",
      capabilities: {
        schemaRead: "not_checked",
        ownedCardRead: "not_checked",
        publishedCardRead: "not_checked",
      },
      checks: [],
      violations: [{ capability: "source", code: "source_unavailable" }],
    };
  }

  const byMethod = new Map(observations.map((entry) => [entry.method, entry]));
  const categories = byMethod.get("categories");
  const attributes = byMethod.get("attributes");
  const feedProduct = byMethod.get("feed-product");
  const product = byMethod.get("product");
  const categoriesRepeat = byMethod.get("categories-repeat");
  const productRepeat = byMethod.get("product-repeat");
  const schemaRead =
    categories?.outcome === "ok" &&
    attributes?.outcome === "ok" &&
    repeatProvesStableContent(categories, categoriesRepeat);
  const ownedCardRead = feedProduct?.outcome === "ok";
  const publishedCardRead =
    product?.outcome === "ok" && repeatProvesStableContent(product, productRepeat);
  const violations: NationalCatalogDiagnosticViolation[] = [];
  const addViolation = (violation: NationalCatalogDiagnosticViolation) => {
    if (
      !violations.some(
        (candidate) =>
          candidate.code === violation.code && candidate.capability === violation.capability,
      )
    ) {
      violations.push(violation);
    }
  };

  if (!schemaRead) addViolation({ capability: "schema_read", code: "schema_read_failed" });
  if (!ownedCardRead) {
    addViolation({ capability: "owned_card_read", code: "owned_card_read_failed" });
  }
  if (!publishedCardRead) {
    addViolation({ capability: "published_card_read", code: "published_card_read_failed" });
  }

  for (const [primaryMethod, repeatMethod, capability] of [
    ["categories", "categories-repeat", "schema_read"],
    ["product", "product-repeat", "published_card_read"],
  ] as const) {
    const primary = byMethod.get(primaryMethod);
    if (primary?.outcome !== "ok") continue;
    const repeat = byMethod.get(repeatMethod);
    const conformant = primary.etagPresent && repeat?.outcome === "not_modified";
    if (!conformant) {
      addViolation({ capability, code: "cache_contract_degraded" });
    }
  }

  for (const [method, capability] of [
    ["categories", "schema_read"],
    ["attributes", "schema_read"],
    ["feed-product", "owned_card_read"],
    ["product", "published_card_read"],
  ] as const) {
    const primary = byMethod.get(method);
    if (primary?.outcome === "ok" && !primary.usagePresent) {
      addViolation({ capability, code: "usage_headers_missing" });
    }
  }

  const checks = observations.map((entry): NationalCatalogDiagnosticCheck => ({
    method: entry.method,
    outcome: entry.outcome,
    resultCount: entry.resultCount,
    cacheObservation: cacheObservation(entry, byMethod),
    usagePresent: entry.usagePresent,
  }));
  return {
    version: 3,
    passed: schemaRead && (ownedCardRead || publishedCardRead),
    sourceStatus,
    contractStatus: violations.length === 0 ? "conformant" : "degraded",
    capabilities: {
      schemaRead: schemaRead ? "available" : "unavailable",
      ownedCardRead: ownedCardRead ? "available" : "unavailable",
      publishedCardRead: publishedCardRead ? "available" : "unavailable",
    },
    checks,
    violations,
  };
}

function repeatProvesStableContent(
  primary: NationalCatalogDiagnosticObservation | undefined,
  repeat: NationalCatalogDiagnosticObservation | undefined,
): boolean {
  if (primary?.outcome !== "ok") return false;
  return (
    repeat?.outcome === "not_modified" ||
    (repeat?.outcome === "ok" && repeat.contentHash === primary.contentHash)
  );
}

function cacheObservation(
  entry: NationalCatalogDiagnosticObservation,
  byMethod: ReadonlyMap<MethodName, NationalCatalogDiagnosticObservation>,
): CacheObservation {
  if (entry.method === "categories" || entry.method === "product") {
    return entry.outcome === "ok"
      ? entry.etagPresent
        ? "etag_present"
        : "etag_missing"
      : "not_checked";
  }
  if (entry.method !== "categories-repeat" && entry.method !== "product-repeat") {
    return "not_checked";
  }
  if (entry.outcome === "not_modified") return "not_modified";
  if (entry.outcome !== "ok") return "not_checked";
  const primary = byMethod.get(entry.method === "categories-repeat" ? "categories" : "product");
  return primary?.contentHash === entry.contentHash ? "same_hash" : "changed_hash";
}

export async function collectNationalCatalogLiveDiagnostic(
  dependencies: DiagnosticDependencies,
): Promise<NationalCatalogDiagnosticEvidence> {
  const source = await dependencies.loadSource();
  if (source.status !== "ok") {
    return evaluateNationalCatalogDiagnostic(source.sourceStatus, []);
  }

  const observations: NationalCatalogDiagnosticObservation[] = [];
  const categories = await attempt(() => dependencies.client.listCategories(source.auth));
  observations.push(
    observation(
      "categories",
      categories,
      categories.status === "ok" ? categories.value.categories.length : 0,
    ),
  );
  if (categories.status === "ok") {
    const repeatedCategories = await attempt(() =>
      dependencies.client.listCategories(
        source.auth,
        categories.etag === null ? {} : { ifNoneMatch: categories.etag },
      ),
    );
    observations.push(
      observation(
        "categories-repeat",
        repeatedCategories,
        repeatedCategories.status === "ok" ? repeatedCategories.value.categories.length : 0,
      ),
    );
  }

  const attributeCategoryId =
    categories.status === "ok" ? lowestUsableCategoryId(categories.value.categories) : null;
  const attributes =
    attributeCategoryId === null
      ? ({ status: "unavailable" } as const)
      : await attempt(() =>
          dependencies.client.getAttributes(source.auth, { catId: attributeCategoryId }),
        );
  observations.push(
    observation(
      "attributes",
      attributes,
      attributes.status === "ok" ? attributes.value.attributes.length : 0,
    ),
  );

  const feedProduct = await attempt(() =>
    dependencies.client.getFeedProducts(source.auth, [source.gtin]),
  );
  observations.push(
    observation(
      "feed-product",
      feedProduct,
      feedProduct.status === "ok" ? feedProduct.value.products.length : 0,
    ),
  );

  const product = await attempt(() =>
    dependencies.client.getPublishedProducts(source.auth, [source.gtin]),
  );
  observations.push(
    observation("product", product, product.status === "ok" ? product.value.products.length : 0),
  );
  if (product.status === "ok") {
    const repeatedProduct = await attempt(() =>
      dependencies.client.getPublishedProducts(
        source.auth,
        [source.gtin],
        product.etag === null ? {} : { ifNoneMatch: product.etag },
      ),
    );
    observations.push(
      observation(
        "product-repeat",
        repeatedProduct,
        repeatedProduct.status === "ok" ? repeatedProduct.value.products.length : 0,
      ),
    );
  }
  return evaluateNationalCatalogDiagnostic("ready", observations);
}

function lowestUsableCategoryId(categories: readonly unknown[]): number | null {
  let selected: number | null = null;
  for (const category of categories) {
    if (typeof category !== "object" || category === null || !("id" in category)) continue;
    const id = category.id;
    if (!Number.isSafeInteger(id) || (id as number) <= 0) continue;
    if (selected === null || (id as number) < selected) selected = id as number;
  }
  return selected;
}

async function attempt<T>(
  request: () => Promise<NationalCatalogResult<T>>,
): Promise<NationalCatalogResult<T>> {
  try {
    return await request();
  } catch {
    return { status: "unavailable" };
  }
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
  if (!encryptionKey) return evaluateNationalCatalogDiagnostic("encryption-key-missing", []);
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
