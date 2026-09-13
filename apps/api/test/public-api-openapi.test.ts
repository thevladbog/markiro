import { describe, expect, it } from "vitest";
import { Test } from "@nestjs/testing";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { PublicProductsController } from "../src/modules/public-api/public-products.controller";
import { PublicInventoriesController } from "../src/modules/public-api/public-inventories.controller";
import { PublicApiGuard } from "../src/modules/public-api/public-api.guard";
import { PublicApiReadService } from "../src/modules/public-api/public-api-read.service";
import { PublicApiRequestService } from "../src/modules/public-api/public-api-request.service";
import { InventoriesService } from "../src/modules/inventories/inventories.service";
import { InventoryLifecycleService } from "../src/modules/inventories/inventory-lifecycle.service";

describe("public API OpenAPI", () => {
  it("documents all ten routes, distinct security and mandatory mutation replay headers", async () => {
    const module = await Test.createTestingModule({
      controllers: [PublicProductsController, PublicInventoriesController],
      providers: [
        PublicApiReadService,
        PublicApiRequestService,
        InventoriesService,
        InventoryLifecycleService,
      ].map((provide) => ({ provide, useValue: {} })),
    })
      .overrideGuard(PublicApiGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      const doc = SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .addApiKey({ type: "apiKey", name: "x-api-key", in: "header" }, "publicApiKey")
          .build(),
      );
      const operations = Object.values(doc.paths).flatMap((path) =>
        [path.get, path.post].filter((x) => x !== undefined),
      );
      expect(operations).toHaveLength(10);
      for (const op of operations) {
        expect(op?.security).toEqual([{ publicApiKey: [] }]);
        expect(op?.summary).toBeTruthy();
        expect(op?.responses["429"]).toBeDefined();
      }
      for (const path of Object.values(doc.paths)) {
        if (!path.post) continue;
        expect(path.post.parameters).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "Idempotency-Key", in: "header", required: true }),
          ]),
        );
        expect(path.post.requestBody).toBeDefined();
      }
      expect(
        JSON.stringify(doc.paths["/public/v1/inventories/{id}/start"]?.post?.responses["201"]),
      ).not.toMatch(/operator|credential|manifest|labelTemplate/i);
      expect(doc.paths["/public/v1/inventories/{id}/results"]?.get?.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "cursor" }),
          expect.objectContaining({ name: "limit" }),
          expect.objectContaining({ name: "classification" }),
        ]),
      );
    } finally {
      await app.close();
    }
  });
});
