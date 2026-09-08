import express from "express";
import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, it } from "vitest";
import { stationScansBodyParser } from "../src/modules/station-scans/body-parser";

describe("station scan body limit", () => {
  const app = express();
  app.use(stationScansBodyParser);
  app.use(express.json());
  app.post(["/station/scans", "/products"], (_req, res) => res.sendStatus(204));
  const server = createServer(app);
  beforeAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      }),
  );
  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  it("accepts the combined scan and label-event channel above the default 100 KiB limit", async () => {
    await request(server)
      .post("/station/scans")
      .send({ payload: "a".repeat(160_000) })
      .expect(204);
  });
  it("retains a bounded station request and the existing limit on other routes", async () => {
    await request(server)
      .post("/station/scans")
      .send({ payload: "a".repeat(2 * 1024 * 1024) })
      .expect(413);
    await request(server)
      .post("/products")
      .send({ payload: "a".repeat(160_000) })
      .expect(413);
  });
});
