import { sourceEnvelopeSchema } from "../src/modules/national-catalog/national-catalog-import-apply-state";
import { randomUUID, createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema, type Db } from "@markiro/db";
import * as contracts from "@markiro/platform-contracts";
import { eq } from "drizzle-orm";
import express from "express";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AppModule } from "../src/app.module";
import { PgBossService } from "../src/jobs/jobs.module";
import { mountAuth, setupAuth } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { ChzTokenService } from "../src/modules/chz-exports/chz-token.service";
import { CHZ_TRUE_API_BASE_URLS } from "../src/modules/signer-agents/chz-constants";
import { ObjectStorageService } from "../src/modules/storage/object-storage.service";
import { ProductsService } from "../src/modules/products/products.service";
import { nationalCatalogBodyParser } from "../src/modules/national-catalog/body-parser";
import { NationalCatalogClient } from "../src/modules/national-catalog/national-catalog.client";
import { NationalCatalogImportRepository } from "../src/modules/national-catalog/national-catalog-import.repository";
import { NationalCatalogImportService } from "../src/modules/national-catalog/national-catalog-import.service";
import { NationalCatalogImportPreviewService } from "../src/modules/national-catalog/national-catalog-import-preview.service";
import { NationalCatalogImportApplyService } from "../src/modules/national-catalog/national-catalog-import-apply.service";
import { NationalCatalogImageService } from "../src/modules/national-catalog/national-catalog-image.service";
import { NationalCatalogRequestCoordinator } from "../src/modules/national-catalog/national-catalog-request-coordinator";
import type {
  NationalCatalogProduct,
  NationalCatalogProductsResponse,
  NationalCatalogResult,
} from "../src/modules/national-catalog/national-catalog.types";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04601234567893";
describe.skipIf(!ready)("National Catalog successful actual AppModule HTTP mappings", () => {
  let app: INestApplication;
  let db: Db;
  let restoreWorkerStartup: (() => void) | undefined;
  const objects = new Map<string, Buffer>();
  const storage = {
    put: vi.fn(async (key: string, body: Buffer) => {
      objects.set(key, Buffer.from(body));
    }),
    get: vi.fn(async (key: string) => {
      const body = objects.get(key);
      if (!body) throw Error("missing fixture object");
      return { body: Buffer.from(body), contentType: "image/webp" };
    }),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  const download = vi.fn(async () =>
    sharp({ create: { width: 80, height: 40, channels: 3, background: "#2463eb" } })
      .png()
      .toBuffer(),
  );
  const source: NationalCatalogProduct = {
    id: 720679,
    name: "Из ЧЗ",
    status: "published",
    detailedStatuses: [],
    identifiers: [{ value: GTIN, type: "gtin", level: null, multiplier: null }],
    categories: [],
    attributes: [],
    images: [
      { sourceId: "good_img", url: "https://images.example/default", barcode: GTIN, primary: true },
      {
        sourceId: "good_images:1",
        url: "https://images.example/alternative",
        barcode: GTIN,
        primary: false,
      },
    ],
    imageIssues: [],
    raw: { good_id: 720679, good_name: "Из ЧЗ" },
  };
  const feed = vi.fn(async (): Promise<NationalCatalogResult<NationalCatalogProductsResponse>> => ({
    status: "ok",
    value: { products: [source] },
    contentHash: "a".repeat(64),
    etag: null,
    usage: { total: null, method: null },
  }));
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL ?? "");
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      url.pathname.length < 2 ||
      url.search
    )
      throw Error(
        "HTTP fixture requires a named local PostgreSQL database without query overrides",
      );
    const env = loadEnv({
      ...process.env,
      SUBSCRIPTION_ENFORCEMENT_MODE: "managed_only",
      NATIONAL_CATALOG_BASE_URL: "https://апи.национальный-каталог.рф",
      NATIONAL_CATALOG_GTIN_IMPORT_ENABLED: "true",
      NATIONAL_CATALOG_IMAGE_IMPORT_ENABLED: "true",
      NATIONAL_CATALOG_IMAGE_ALLOWED_HOSTS: "images.example",
    });
    const setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    })
      .overrideProvider(NationalCatalogClient)
      .useValue({
        getFeedProducts: feed,
        getFeedProductsByIds: feed,
        listOwnProducts: vi.fn(() => {
          throw Error("unexpected own enumeration");
        }),
      })
      .overrideProvider(ChzTokenService)
      .useValue({
        getCatalogToken: vi.fn(async () => ({
          status: "ok",
          auth: { baseUrl: CHZ_TRUE_API_BASE_URLS.production, token: "synthetic-fixture-token" },
          obtainedAt: new Date(),
        })),
        inspectCatalogToken: vi.fn(async () => "ok"),
      })
      .overrideProvider(ObjectStorageService)
      .useValue(storage)
      .overrideProvider(NationalCatalogImageService)
      .useFactory({
        inject: [
          NationalCatalogImportRepository,
          NationalCatalogImportService,
          NationalCatalogRequestCoordinator,
          ProductsService,
        ],
        factory: (
          repo: NationalCatalogImportRepository,
          sessions: NationalCatalogImportService,
          coordinator: NationalCatalogRequestCoordinator,
          products: ProductsService,
        ) =>
          new NationalCatalogImageService(
            repo,
            sessions,
            coordinator,
            storage,
            products,
            { enabled: true, verifiedHosts: ["images.example"] },
            download,
          ),
      })
      .compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(nationalCatalogBodyParser);
    server.use(express.json());
    // This HTTP mapping fixture drives workers explicitly. A live repair worker
    // could concurrently consume another fixture's persisted image jobs.
    const startup = vi.spyOn(app.get(PgBossService), "onModuleInit").mockResolvedValue(undefined);
    restoreWorkerStartup = () => startup.mockRestore();
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      restoreWorkerStartup?.();
    }
  });
  it("maps selection, preparation, explicit photo, cached GET, apply/retry receipts and link removal", async () => {
    const agent = request.agent(app.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    await db
      .insert(schema.integrationChannels)
      .values({ tenantId, type: "chestny_znak", settings: { environment: "production" } });
    const productId = randomUUID();
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Моё имя" });
    const started = contracts.importSessionSchema.parse(
      (
        await agent
          .post("/national-catalog/import-sessions")
          .send({ mode: "gtins", text: GTIN })
          .expect(200)
      ).body,
    );
    const base = `/national-catalog/import-sessions/${started.id}`;
    expect(
      contracts.importSessionSchema.parse(
        (
          await agent
            .post(base + "/retries")
            .send({})
            .expect(200)
        ).body,
      ).id,
    ).toBe(started.id);
    await app.get(NationalCatalogImportService).resume(tenantId, started.id);
    const list = contracts.importItemsResponseSchema.parse(
      (await agent.get(base + "/items?limit=1&includeArchived=false").expect(200)).body,
    );
    const item = list.items[0];
    if (!item) throw Error("enumerated item missing");
    expect(item).toMatchObject({ gtin14: GTIN, productId });
    const current = contracts.importSessionSchema.parse((await agent.get(base).expect(200)).body);
    const selected = contracts.importSessionSchema.parse(
      (
        await agent
          .put(base + "/selection")
          .send({ expectedRevision: current.revision, itemIds: [item.id] })
          .expect(200)
      ).body,
    );
    expect(selected.selected).toBe(1);
    const prepared = contracts.importPrepareResponseSchema.parse(
      (
        await agent
          .post(base + "/previews")
          .send({
            requestId: randomUUID(),
            itemIds: [item.id],
            manualNames: [],
            categoryChoices: [],
          })
          .expect(200)
      ).body,
    );
    const prepPath = base + `/preparations/${prepared.preparation.id}`;
    expect(
      contracts.importPrepareResponseSchema.parse(
        (
          await agent
            .post(prepPath + "/retries")
            .send({})
            .expect(200)
        ).body,
      ).preparation.id,
    ).toBe(prepared.preparation.id);
    await app
      .get(NationalCatalogImportPreviewService)
      .resumePreparation(tenantId, started.id, prepared.preparation.id);
    const views = contracts.importPrepareResponseSchema.parse(
      (await agent.get(prepPath).expect(200)).body,
    );
    const preview = views.items[0];
    if (!preview) throw Error(JSON.stringify(views));
    // Admission conflicts identify only the tenant/session-resolved rejected preview.
    const previewTable = schema.nationalCatalogImportPreviews;
    const [originalPreview] = await db
      .select()
      .from(previewTable)
      .where(eq(previewTable.id, preview.id));
    if (!originalPreview) throw Error("stored preview missing");
    const rejectedBody = {
      requestId: randomUUID(),
      decisions: [
        {
          previewId: preview.id,
          acceptedEntryIds: [],
          linkAction: preview.linkAction,
          photo: { kind: "keep" },
        },
      ],
    };
    for (const reason of ["preview_expired", "environment_mismatch"] as const) {
      await db
        .update(previewTable)
        .set(
          reason === "preview_expired"
            ? { expiresAt: new Date(Date.now() - 1000) }
            : {
                expiresAt: originalPreview.expiresAt,
                source: {
                  ...sourceEnvelopeSchema.parse(originalPreview.source),
                  environment: "sandbox",
                },
              },
        )
        .where(eq(previewTable.id, preview.id));
      const before = await db.select().from(previewTable).where(eq(previewTable.id, preview.id));
      const response = await agent
        .post(base + "/applies")
        .send(rejectedBody)
        .expect(409);
      expect(response.body).toEqual({
        statusCode: 409,
        error: "Conflict",
        message: reason,
        previewIds: [preview.id],
      });
      expect(await db.select().from(previewTable).where(eq(previewTable.id, preview.id))).toEqual(
        before,
      );
      expect(
        await db
          .select()
          .from(schema.nationalCatalogImportOperations)
          .where(eq(schema.nationalCatalogImportOperations.tenantId, tenantId)),
      ).toEqual([]);
      expect(
        await db
          .select()
          .from(schema.nationalCatalogImportOperationItems)
          .where(eq(schema.nationalCatalogImportOperationItems.tenantId, tenantId)),
      ).toEqual([]);
    }
    const beforeDenial = await db
      .select()
      .from(previewTable)
      .where(eq(previewTable.id, preview.id));
    const otherSession = contracts.importSessionSchema.parse(
      (
        await agent
          .post("/national-catalog/import-sessions")
          .send({ mode: "gtins", text: GTIN })
          .expect(200)
      ).body,
    );
    const wrongSession = await agent
      .post(`/national-catalog/import-sessions/${otherSession.id}/applies`)
      .send(rejectedBody)
      .expect(404);
    expect(wrongSession.body).not.toHaveProperty("previewIds");
    const foreignAgent = request.agent(app.getHttpServer());
    await signUpAndActivate(foreignAgent);
    const denied = await foreignAgent
      .post(base + "/applies")
      .send(rejectedBody)
      .expect(404);
    expect(denied.body).not.toHaveProperty("previewIds");
    expect(await db.select().from(previewTable).where(eq(previewTable.id, preview.id))).toEqual(
      beforeDenial,
    );
    expect(
      await db
        .select()
        .from(schema.nationalCatalogImportOperations)
        .where(eq(schema.nationalCatalogImportOperations.tenantId, tenantId)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.nationalCatalogImportOperationItems)
        .where(eq(schema.nationalCatalogImportOperationItems.tenantId, tenantId)),
    ).toEqual([]);
    await db
      .update(previewTable)
      .set({ expiresAt: originalPreview.expiresAt, source: originalPreview.source })
      .where(eq(previewTable.id, preview.id));
    const alternative = preview.photos.find((p) => !p.selectedByDefault);
    if (!alternative) throw Error("alternative missing");
    const photo = contracts.importPhotoSchema.parse(
      (
        await agent
          .post(base + `/previews/${preview.id}/images/${alternative.candidateId}`)
          .send({})
          .expect(200)
      ).body,
    );
    expect(photo.candidateId).toBe(alternative.candidateId);
    const images = app.get(NationalCatalogImageService);
    await images.resume(tenantId, started.id, preview.id, alternative.candidateId);
    const shown = await agent
      .get(base + `/images/${alternative.candidateId}`)
      .expect(200)
      .expect("Content-Type", /image\/webp/)
      .expect("Cache-Control", "private, no-store")
      .expect("X-Content-Type-Options", "nosniff");
    expect(Buffer.isBuffer(shown.body)).toBe(true);
    expect(await sharp(shown.body).metadata()).toMatchObject({
      format: "webp",
      width: 80,
      height: 40,
    });
    const checksum = createHash("sha256").update(shown.body).digest("hex");
    expect(shown.body).toEqual(
      (await images.readPreview(tenantId, started.id, alternative.candidateId)).buffer,
    );
    const accepted = contracts.importResultSchema.parse(
      (
        await agent
          .post(base + "/applies")
          .send({
            requestId: randomUUID(),
            decisions: [
              {
                previewId: preview.id,
                acceptedEntryIds: [],
                linkAction: "attach",
                photo: { kind: "candidate", candidateId: alternative.candidateId },
              },
            ],
          })
          .expect(200)
      ).body,
    );
    const applies = app.get(NationalCatalogImportApplyService);
    await applies.resume(tenantId, accepted.operationId);
    // Controlled local storage outage exhausts the existing four-attempt image cycle.
    storage.get.mockRejectedValueOnce(Error("temporary fixture storage outage"));
    await images.apply(tenantId, accepted.operationId, preview.id);
    const receipts = schema.nationalCatalogImportOperationItems;
    await db
      .update(receipts)
      .set({ imageAttempts: 4, nextImageAttemptAt: null })
      .where(eq(receipts.operationId, accepted.operationId));
    const failed = contracts.importResultSchema.parse(
      (await agent.get(base + `/applies/${accepted.operationId}`).expect(200)).body,
    );
    expect(failed.items[0]).toMatchObject({ product: "applied", image: "failed" });
    const [beforeRetry] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operationId, accepted.operationId));
    const retry = contracts.importResultSchema.parse(
      (
        await agent
          .post(base + `/applies/${accepted.operationId}/retries`)
          .send({ previewIds: [preview.id] })
          .expect(200)
      ).body,
    );
    expect(retry.items[0]).toMatchObject({ product: "applied", image: "pending" });
    await images.apply(tenantId, retry.operationId, preview.id);
    const result = contracts.importResultSchema.parse(
      (await agent.get(base + `/applies/${retry.operationId}`).expect(200)).body,
    );
    expect(result.items[0]).toMatchObject({ product: "applied", image: "applied", productId });
    const [active] = await db
      .select()
      .from(schema.productImages)
      .innerJoin(schema.mediaAssets, eq(schema.mediaAssets.id, schema.productImages.assetId))
      .where(eq(schema.productImages.productId, productId));
    expect(active?.media_assets.checksum).toBe(checksum);
    expect(objects.get(active?.media_assets.objectKey ?? "")).toEqual(shown.body);
    expect(download).toHaveBeenCalledTimes(1);
    expect(retry.operationId).toBe(accepted.operationId);
    const [afterRetry] = await db
      .select()
      .from(receipts)
      .where(eq(receipts.operationId, accepted.operationId));
    expect(afterRetry).toMatchObject({
      id: beforeRetry?.id,
      acceptedImageId: beforeRetry?.acceptedImageId,
      appliedEvidence: beforeRetry?.appliedEvidence,
      productResult: "applied",
      imageResult: "applied",
    });
    const linkPath = `/products/${productId}/national-catalog/link`;
    const detail = contracts.chzLinkDetailSchema.parse(
      (await agent.get(linkPath).expect(200)).body,
    );
    expect(detail.link).toMatchObject({
      cardId: "720679",
      boundGtin14: GTIN,
      environment: "production",
    });
    const removed = contracts.chzSummarySchema.parse(
      (
        await agent
          .delete(linkPath)
          .send({ action: "remove", expectedRevision: detail.link?.revision })
          .expect(200)
      ).body,
    );
    expect(removed.linkId).toBeNull();
    const [preserved] = await db
      .select()
      .from(schema.products)
      .where(eq(schema.products.id, productId));
    expect(preserved).toMatchObject({ name: "Моё имя", gtin14: GTIN });
    expect(
      await db
        .select()
        .from(schema.productImages)
        .where(eq(schema.productImages.productId, productId)),
    ).toHaveLength(1);
    expect(
      contracts.chzLinkDetailSchema.parse((await agent.get(linkPath).expect(200)).body).link,
    ).toBeNull();
    expect(
      contracts.importSessionSchema.parse(
        (
          await agent
            .post(base + "/cancel")
            .send({})
            .expect(200)
        ).body,
      ).state,
    ).toBe("cancelled");
    expect(
      contracts.importResultSchema.parse(
        (await agent.get(base + `/applies/${retry.operationId}`).expect(200)).body,
      ).items[0]?.image,
    ).toBe("applied");
  });
});
