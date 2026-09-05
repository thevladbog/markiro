import "reflect-metadata";
import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsDevelopmentApplication } from "../src/deployment/us-bootstrap";
import { listenOnLoopback } from "./support/listen-loopback";

describe("isolated US development composition", () => {
  let app: INestApplication;
  beforeAll(async () => {
    const env = parseEnv(readFileSync("../../deploy/us-development/local.env.example", "utf8"));
    app = await createUsDevelopmentApplication(env);
    await app.init();
    await listenOnLoopback(app);
  });
  afterAll(async () => {
    if (app) await app.close();
  });

  it("identifies the edition without infrastructure or secret fields", async () => {
    const result = await request(app.getHttpServer()).get("/deployment").expect(200);
    expect(result.body).toEqual({
      edition: "US",
      releaseEnabled: false,
      interfaceLocales: ["en-US", "es-US"],
      defaultInterfaceLocale: "en-US",
    });
    expect(result.headers["cache-control"]).toBe("no-store");
  });
  it("distinguishes liveness from unfinished business readiness", async () => {
    await request(app.getHttpServer()).get("/health/live").expect(200, { status: "ok" });
    await request(app.getHttpServer())
      .get("/health/ready")
      .expect(503, { status: "unavailable", reason: "us_business_modules_not_ready" });
  });
  it.each([
    "/1c_exchange",
    "/station/bootstrap",
    "/kiosk/bootstrap",
    "/integrations",
    "/signer-agents",
    "/chz-exports",
    "/national-catalog",
    "/api/auth/get-session",
    "/api/platform-auth/get-session",
  ])("does not register an unimplemented or RU route: %s", async (path) => {
    await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer()).post(path).expect(404);
  });
  it("requires a US session for the mounted profile route", async () => {
    await request(app.getHttpServer())
      .get("/traceability/profile")
      .set("Host", "localhost:3100")
      .expect(401);
  });
  it("permits only the configured office origin", async () => {
    const allowed = await request(app.getHttpServer())
      .get("/deployment")
      .set("Origin", "http://localhost:5174")
      .expect(200);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5174");
    const other = await request(app.getHttpServer())
      .get("/deployment")
      .set("Origin", "http://localhost:5173");
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
