import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogPublisherController } from "../src/modules/release-catalog/catalog-publisher.controller";
import { CatalogService } from "../src/modules/release-catalog/catalog-service";
import {
  CatalogPublisherGuard,
  CATALOG_PUBLISHER_VERIFY,
} from "../src/modules/release-catalog/catalog-publisher.guard";
import { verifyPublisherToken } from "../src/modules/release-catalog/catalog-oidc";
import { oidcFixture } from "./support/catalog-oidc";
import { listenOnLoopback } from "./support/listen-loopback";
import { compareCatalogVersions } from "../src/modules/release-catalog/catalog-product";
describe("publisher controllers fail closed without configured storage", () => {
  let app: INestApplication, token: string;
  beforeAll(async () => {
    const f = await oidcFixture();
    token = await f.sign();
    const module = await Test.createTestingModule({
      controllers: [CatalogPublisherController],
      providers: [
        CatalogPublisherGuard,
        { provide: CatalogService, useValue: null },
        {
          provide: CATALOG_PUBLISHER_VERIFY,
          useValue: (t: string) =>
            verifyPublisherToken(t, f.config, Math.floor(Date.now() / 1000), f.resolver),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    await app?.close();
  });
  it("all actual routes require machine authentication and configured catalog", async () => {
    for (const [method, path] of [
      ["post", "/release-publisher/intents"],
      ["post", `/release-publisher/intents/${randomUUID()}/commit`],
      ["get", `/release-publisher/intents/${randomUUID()}`],
      ["put", "/release-publisher/channels/station/stable"],
      ["get", "/release-publisher/channels/station/stable"],
      ["get", "/release-publisher/publications/station/stable/1.0.0"],
    ] as const) {
      await request(app.getHttpServer())[method](path).expect(403);
      await request(app.getHttpServer())
        [method](path)
        .set("Authorization", `Bearer ${token}`)
        .expect(503);
    }
  });
  it("OpenAPI exposes the separate machine security boundary and strict bodies", () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .addBearerAuth(
          { type: "http", scheme: "bearer", bearerFormat: "GitHub OIDC JWT" },
          "releasePublisherOidc",
        )
        .build(),
    );
    expect(Object.keys(doc.paths)).toHaveLength(5);
    expect(doc.paths["/release-publisher/intents"]?.post?.security).toEqual([
      { releasePublisherOidc: [] },
    ]);
    expect(
      doc.paths["/release-publisher/channels/{product}/{channel}"]?.put?.requestBody,
    ).toMatchObject({
      content: { "application/json": { schema: { additionalProperties: false } } },
    });
  });
});
it("uses numeric version ordering including beta ordinals", () => {
  expect(compareCatalogVersions("1.0.10", "1.0.9")).toBe(1);
  expect(compareCatalogVersions("1.0.0-beta.10", "1.0.0-beta.9")).toBe(1);
  expect(compareCatalogVersions("1.0.0", "1.0.0-beta.10")).toBe(1);
  expect(compareCatalogVersions("1.0.0", "1.0.0")).toBe(0);
});
