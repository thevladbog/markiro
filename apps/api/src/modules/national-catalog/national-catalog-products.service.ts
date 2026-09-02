import { createHash } from "node:crypto";

import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { schema, type Db } from "@markiro/db";
import { and, desc, eq, isNotNull, notInArray } from "drizzle-orm";

import { DB } from "../../auth/auth.module";
import type { ChzTokenService } from "../chz-exports/chz-token.service";
import type { NationalCatalogClient } from "./national-catalog.client";
import type { NationalCatalogProduct, NationalCatalogResult } from "./national-catalog.types";

export type NationalCatalogCardReadMethod = "feed_product" | "product";

export interface NationalCatalogCardToStore {
  cardId: string;
  cardStatus: string;
  contentHash: string;
  etag: string | null;
  payload: Record<string, unknown>;
}

export interface NationalCatalogStoredCard {
  snapshotId: string;
  cardId: string;
  cardStatus: string;
  sourceMethod: NationalCatalogCardReadMethod;
  changed: boolean;
}

export interface NationalCatalogProductsRepository {
  findProduct(tenantId: string, productId: string): Promise<{ id: string; gtin14: string } | null>;
  findProviderEtag(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
  ): Promise<string | null>;
  markNotModified(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    checkedAt: Date,
  ): Promise<NationalCatalogStoredCard[]>;
  markNotFound(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    checkedAt: Date,
  ): Promise<void>;
  markFailed(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    outcome: "unauthorized" | "forbidden" | "rate_limited" | "invalid_response" | "unavailable",
    checkedAt: Date,
  ): Promise<void>;
  storeCards(
    tenantId: string,
    productId: string,
    gtin14: string,
    sourceMethod: NationalCatalogCardReadMethod,
    cards: readonly NationalCatalogCardToStore[],
    checkedAt: Date,
  ): Promise<NationalCatalogStoredCard[]>;
}

export const NATIONAL_CATALOG_PRODUCTS_REPOSITORY = Symbol("NATIONAL_CATALOG_PRODUCTS_REPOSITORY");

export class DrizzleNationalCatalogProductsRepository implements NationalCatalogProductsRepository {
  constructor(private readonly db: Db) {}

  async findProduct(tenantId: string, productId: string) {
    const [product] = await this.db
      .select({ id: schema.products.id, gtin14: schema.products.gtin14 })
      .from(schema.products)
      .where(
        and(
          eq(schema.products.tenantId, tenantId),
          eq(schema.products.id, productId),
          eq(schema.products.archived, false),
        ),
      )
      .limit(1);
    return product?.gtin14 ? { id: product.id, gtin14: product.gtin14 } : null;
  }

  async findProviderEtag(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
  ) {
    const [cursor] = await this.db
      .select({ providerEtag: schema.nationalCatalogCardFreshness.providerEtag })
      .from(schema.nationalCatalogCardFreshness)
      .where(
        and(
          eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
          eq(schema.nationalCatalogCardFreshness.productId, productId),
          eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
          isNotNull(schema.nationalCatalogCardFreshness.providerEtag),
        ),
      )
      .orderBy(desc(schema.nationalCatalogCardFreshness.lastCheckedAt))
      .limit(1);
    return cursor?.providerEtag ?? null;
  }

  markNotModified(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    checkedAt: Date,
  ): Promise<NationalCatalogStoredCard[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(schema.nationalCatalogCardFreshness)
        .set({ lastCheckedAt: checkedAt, lastOutcome: "not_modified", updatedAt: checkedAt })
        .where(
          and(
            eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
            eq(schema.nationalCatalogCardFreshness.productId, productId),
            eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
          ),
        );
      const rows = await tx
        .select({
          snapshotId: schema.nationalCatalogCardFreshness.latestSnapshotId,
          cardId: schema.nationalCatalogCardFreshness.cardId,
          cardStatus: schema.nationalCatalogCardSnapshots.cardStatus,
        })
        .from(schema.nationalCatalogCardFreshness)
        .innerJoin(
          schema.nationalCatalogCardSnapshots,
          and(
            eq(
              schema.nationalCatalogCardSnapshots.tenantId,
              schema.nationalCatalogCardFreshness.tenantId,
            ),
            eq(
              schema.nationalCatalogCardSnapshots.productId,
              schema.nationalCatalogCardFreshness.productId,
            ),
            eq(
              schema.nationalCatalogCardSnapshots.cardId,
              schema.nationalCatalogCardFreshness.cardId,
            ),
            eq(
              schema.nationalCatalogCardSnapshots.sourceMethod,
              schema.nationalCatalogCardFreshness.sourceMethod,
            ),
            eq(
              schema.nationalCatalogCardSnapshots.id,
              schema.nationalCatalogCardFreshness.latestSnapshotId,
            ),
          ),
        )
        .where(
          and(
            eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
            eq(schema.nationalCatalogCardFreshness.productId, productId),
            eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
          ),
        )
        .orderBy(schema.nationalCatalogCardFreshness.cardId);
      return rows.map((row) => ({ ...row, sourceMethod, changed: false }));
    });
  }

  async markNotFound(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    checkedAt: Date,
  ): Promise<void> {
    await this.db
      .update(schema.nationalCatalogCardFreshness)
      .set({ lastCheckedAt: checkedAt, lastOutcome: "not_found", updatedAt: checkedAt })
      .where(
        and(
          eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
          eq(schema.nationalCatalogCardFreshness.productId, productId),
          eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
        ),
      );
  }

  async markFailed(
    tenantId: string,
    productId: string,
    sourceMethod: NationalCatalogCardReadMethod,
    outcome: "unauthorized" | "forbidden" | "rate_limited" | "invalid_response" | "unavailable",
    checkedAt: Date,
  ): Promise<void> {
    await this.db
      .update(schema.nationalCatalogCardFreshness)
      .set({ lastCheckedAt: checkedAt, lastOutcome: outcome, updatedAt: checkedAt })
      .where(
        and(
          eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
          eq(schema.nationalCatalogCardFreshness.productId, productId),
          eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
        ),
      );
  }

  storeCards(
    tenantId: string,
    productId: string,
    gtin14: string,
    sourceMethod: NationalCatalogCardReadMethod,
    cards: readonly NationalCatalogCardToStore[],
    checkedAt: Date,
  ): Promise<NationalCatalogStoredCard[]> {
    return this.db.transaction(async (tx) => {
      const stored: NationalCatalogStoredCard[] = [];
      for (const card of cards) {
        const [inserted] = await tx
          .insert(schema.nationalCatalogCardSnapshots)
          .values({
            tenantId,
            productId,
            gtin14,
            cardId: card.cardId,
            cardStatus: card.cardStatus,
            sourceMethod,
            payloadFormatVersion: 2,
            etag: card.etag,
            contentHash: card.contentHash,
            payload: card.payload,
            fetchedAt: checkedAt,
          })
          .onConflictDoNothing()
          .returning({ id: schema.nationalCatalogCardSnapshots.id });
        const snapshotId =
          inserted?.id ??
          (
            await tx
              .select({ id: schema.nationalCatalogCardSnapshots.id })
              .from(schema.nationalCatalogCardSnapshots)
              .where(
                and(
                  eq(schema.nationalCatalogCardSnapshots.tenantId, tenantId),
                  eq(schema.nationalCatalogCardSnapshots.productId, productId),
                  eq(schema.nationalCatalogCardSnapshots.cardId, card.cardId),
                  eq(schema.nationalCatalogCardSnapshots.sourceMethod, sourceMethod),
                  eq(schema.nationalCatalogCardSnapshots.contentHash, card.contentHash),
                ),
              )
              .limit(1)
          )[0]?.id;
        if (!snapshotId) throw new Error("National Catalog snapshot persistence failed");

        await tx
          .insert(schema.nationalCatalogCardFreshness)
          .values({
            tenantId,
            productId,
            cardId: card.cardId,
            sourceMethod,
            latestSnapshotId: snapshotId,
            providerEtag: card.etag,
            contentHash: card.contentHash,
            lastCheckedAt: checkedAt,
            lastChangedAt: checkedAt,
            lastOutcome: inserted ? "changed" : "unchanged",
          })
          .onConflictDoUpdate({
            target: [
              schema.nationalCatalogCardFreshness.tenantId,
              schema.nationalCatalogCardFreshness.productId,
              schema.nationalCatalogCardFreshness.cardId,
              schema.nationalCatalogCardFreshness.sourceMethod,
            ],
            set: {
              latestSnapshotId: snapshotId,
              providerEtag: card.etag,
              contentHash: card.contentHash,
              lastCheckedAt: checkedAt,
              ...(inserted
                ? { lastChangedAt: checkedAt, lastOutcome: "changed" as const }
                : { lastOutcome: "unchanged" as const }),
              updatedAt: checkedAt,
            },
          });
        stored.push({
          snapshotId,
          cardId: card.cardId,
          cardStatus: card.cardStatus,
          sourceMethod,
          changed: Boolean(inserted),
        });
      }
      const currentIdentity = and(
        eq(schema.nationalCatalogCardFreshness.tenantId, tenantId),
        eq(schema.nationalCatalogCardFreshness.productId, productId),
        eq(schema.nationalCatalogCardFreshness.sourceMethod, sourceMethod),
      );
      await tx.delete(schema.nationalCatalogCardFreshness).where(
        cards.length === 0
          ? currentIdentity
          : and(
              currentIdentity,
              notInArray(
                schema.nationalCatalogCardFreshness.cardId,
                cards.map((card) => card.cardId),
              ),
            ),
      );
      return stored;
    });
  }
}

export type NationalCatalogLookupOutcome =
  | "found"
  | "selection_required"
  | "empty"
  | "token_unconfigured"
  | "token_missing"
  | "token_expired"
  | "token_undecryptable"
  | "provider_unauthorized"
  | "provider_rate_limited"
  | "provider_invalid_response"
  | "provider_unavailable";

@Injectable()
export class NationalCatalogProductsService {
  constructor(
    @Inject(NATIONAL_CATALOG_PRODUCTS_REPOSITORY)
    private readonly repository: NationalCatalogProductsRepository,
    private readonly client: NationalCatalogClient,
    private readonly tokens: ChzTokenService,
    private readonly baseUrl: string | undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async lookup(
    tenantId: string,
    productId: string,
  ): Promise<{
    outcome: NationalCatalogLookupOutcome;
    cards: NationalCatalogStoredCard[];
  }> {
    const product = await this.repository.findProduct(tenantId, productId);
    if (!product) throw new NotFoundException();
    if (!this.baseUrl) return { outcome: "token_unconfigured", cards: [] };

    const token = await this.tokens.getActiveToken(tenantId);
    if (token.status !== "ok") return { outcome: `token_${token.status}`, cards: [] };
    const auth = { baseUrl: this.baseUrl, token: token.auth.token };
    const feedEtag = await this.repository.findProviderEtag(tenantId, productId, "feed_product");
    const feed = feedEtag
      ? await this.client.getFeedProducts(auth, [product.gtin14], { ifNoneMatch: feedEtag })
      : await this.client.getFeedProducts(auth, [product.gtin14]);
    const selected = await this.selectCardRead(tenantId, productId, auth, product.gtin14, feed);
    if (selected.result.status === "not_modified") {
      const cards = await this.repository.markNotModified(
        tenantId,
        productId,
        selected.sourceMethod,
        this.now(),
      );
      return {
        outcome: cards.length > 1 ? "selection_required" : cards.length === 1 ? "found" : "empty",
        cards,
      };
    }
    if (selected.result.status === "not_found") {
      await this.repository.markNotFound(tenantId, productId, selected.sourceMethod, this.now());
      return { outcome: "empty", cards: [] };
    }
    if (selected.result.status !== "ok") {
      await this.repository.markFailed(
        tenantId,
        productId,
        selected.sourceMethod,
        providerFreshnessOutcome(selected.result.status),
        this.now(),
      );
      return { outcome: providerOutcome(selected.result.status), cards: [] };
    }
    const cards = selected.result.value.products
      .filter((card) => cardIdentifiesGtin(card, product.gtin14))
      .sort((left, right) => left.id - right.id)
      .map((card): NationalCatalogCardToStore => ({
        cardId: String(card.id),
        cardStatus: card.status ?? "unknown",
        contentHash: canonicalJsonHash(card.raw),
        etag: selected.result.status === "ok" ? selected.result.etag : null,
        payload: {
          raw: card.raw,
          normalized: {
            name: card.name,
            categories: card.categories.map((category) => ({ id: category.id })),
            attributes: card.attributes.map((attribute) => ({
              id: attribute.id,
              value: attribute.value,
              unit: attribute.valueType,
            })),
          },
        },
      }));
    if (cards.length !== selected.result.value.products.length) {
      await this.repository.markFailed(
        tenantId,
        productId,
        selected.sourceMethod,
        "invalid_response",
        this.now(),
      );
      return { outcome: "provider_invalid_response", cards: [] };
    }
    if (cards.length === 0) {
      await this.repository.markNotFound(tenantId, productId, selected.sourceMethod, this.now());
      return { outcome: "empty", cards: [] };
    }
    const stored = await this.repository.storeCards(
      tenantId,
      productId,
      product.gtin14,
      selected.sourceMethod,
      cards,
      this.now(),
    );
    return {
      outcome: stored.length > 1 ? "selection_required" : stored.length === 1 ? "found" : "empty",
      cards: stored,
    };
  }

  private async selectCardRead(
    tenantId: string,
    productId: string,
    auth: { baseUrl: string; token: string },
    gtin: string,
    feed: NationalCatalogResult<{ products: NationalCatalogProduct[] }>,
  ): Promise<{
    sourceMethod: NationalCatalogCardReadMethod;
    result: NationalCatalogResult<{ products: NationalCatalogProduct[] }>;
  }> {
    if (feed.status === "ok" && feed.value.products.length > 0) {
      return { sourceMethod: "feed_product", result: feed };
    }
    if (
      feed.status === "not_modified" ||
      feed.status === "unauthorized" ||
      feed.status === "rate_limited"
    ) {
      return { sourceMethod: "feed_product", result: feed };
    }
    if (feed.status === "ok" || feed.status === "not_found") {
      await this.repository.markNotFound(tenantId, productId, "feed_product", this.now());
    } else {
      await this.repository.markFailed(
        tenantId,
        productId,
        "feed_product",
        providerFreshnessOutcome(feed.status),
        this.now(),
      );
    }
    const publishedEtag = await this.repository.findProviderEtag(tenantId, productId, "product");
    return {
      sourceMethod: "product",
      result: publishedEtag
        ? await this.client.getPublishedProducts(auth, [gtin], { ifNoneMatch: publishedEtag })
        : await this.client.getPublishedProducts(auth, [gtin]),
    };
  }
}

function providerFreshnessOutcome(
  status: Exclude<NationalCatalogResult<unknown>["status"], "ok" | "not_modified" | "not_found">,
): "unauthorized" | "forbidden" | "rate_limited" | "invalid_response" | "unavailable" {
  return status;
}

function providerOutcome(
  status: Exclude<NationalCatalogResult<unknown>["status"], "ok">,
): NationalCatalogLookupOutcome {
  if (status === "unauthorized") return "provider_unauthorized";
  if (status === "rate_limited") return "provider_rate_limited";
  if (status === "invalid_response") return "provider_invalid_response";
  return "provider_unavailable";
}

function cardIdentifiesGtin(card: NationalCatalogProduct, gtin: string): boolean {
  return card.identifiers.some(
    (identifier) => identifier.type.toLowerCase() === "gtin" && identifier.value === gtin,
  );
}

export function canonicalJsonHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortJson(value)))
    .digest("hex");
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

export function provideNationalCatalogProductsRepository(db: Db) {
  return new DrizzleNationalCatalogProductsRepository(db);
}

export const nationalCatalogProductsRepositoryProvider = {
  provide: NATIONAL_CATALOG_PRODUCTS_REPOSITORY,
  inject: [DB],
  useFactory: provideNationalCatalogProductsRepository,
};
