import { Controller, Post, Req, UseGuards, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CatalogPublisherGuard,
  CatalogPublisherRoute,
  CATALOG_PUBLISHER_VERIFY,
  isCatalogPublisherRoute,
  type RequestWithPublisher,
} from "../src/modules/release-catalog/catalog-publisher.guard";
import { verifyPublisherToken } from "../src/modules/release-catalog/catalog-oidc";
import { listenOnLoopback } from "./support/listen-loopback";
import { oidcFixture } from "./support/catalog-oidc";
@Controller("release-publisher")
class MachineFixture {
  @Post(":product")
  @CatalogPublisherRoute()
  publish(@Req() req: RequestWithPublisher) {
    return { product: req.catalogPublisher?.product, runId: req.catalogPublisher?.runId };
  }
  @Post("unclassified/:product")
  @UseGuards(CatalogPublisherGuard)
  unclassified() {
    return { accepted: true };
  }
}
describe("separate machine publisher HTTP boundary", () => {
  let app: INestApplication, f: Awaited<ReturnType<typeof oidcFixture>>, token: string;
  beforeAll(async () => {
    f = await oidcFixture();
    token = await f.sign();
    const module = await Test.createTestingModule({
      controllers: [MachineFixture],
      providers: [
        CatalogPublisherGuard,
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
  it("accepts only the token product and exposes no session capabilities", async () => {
    const result = await request(app.getHttpServer())
      .post("/release-publisher/station")
      .set("Authorization", `Bearer ${token}`)
      .expect(201);
    expect(result.body).toEqual({ product: "station", runId: "789" });
    for (const product of ["handheld", "standalone", "signer"])
      await request(app.getHttpServer())
        .post(`/release-publisher/${product}`)
        .set("Authorization", `Bearer ${token}`)
        .expect(403);
    await request(app.getHttpServer())
      .post("/platform/team")
      .set("Authorization", `Bearer ${token}`)
      .expect(404);
  });
  it("rejects tenant, station, kiosk and cabinet credentials", async () => {
    for (const headers of [
      { Cookie: "better-auth.session_token=fixture" },
      { "x-station-token": "fixture" },
      { "x-kiosk-token": "fixture" },
      { Authorization: "Bearer tenant-fixture" },
      { Authorization: "Basic fixture" },
    ])
      await request(app.getHttpServer())
        .post("/release-publisher/station")
        .set(headers)
        .expect(403);
  });
  it("requires explicit machine policy as well as its guard", async () => {
    expect(isCatalogPublisherRoute(MachineFixture, MachineFixture.prototype.publish)).toBe(true);
    expect(isCatalogPublisherRoute(MachineFixture, MachineFixture.prototype.unclassified)).toBe(
      false,
    );
    await request(app.getHttpServer())
      .post("/release-publisher/unclassified/station")
      .set("Authorization", `Bearer ${token}`)
      .expect(403);
  });
});
