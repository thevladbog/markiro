import { createServer } from "node:http";
import { once } from "node:events";
import express from "express";
import request from "supertest";
import { expect, it } from "vitest";
import { palletSourcesBodyParser } from "../src/modules/station-warehouse-reprint/pallet-body-parser";
it("admits a bounded large V2 snapshot without raising unrelated route limits", async () => {
  const app = express();
  app.use(palletSourcesBodyParser);
  app.use(express.json());
  app.post("/station/warehouse-reprint/:path", (req, res) =>
    res.json({ size: req.body.value.length }),
  );
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const value = "a".repeat(120000);
    expect(
      (
        await request(server)
          .post("/station/warehouse-reprint/pallet-renderings-v2")
          .send({ value })
          .expect(200)
      ).body,
    ).toEqual({ size: value.length });
    await request(server)
      .post("/station/warehouse-reprint/pallet-events-v2")
      .send({ value })
      .expect(413);
    await request(server)
      .post("/station/warehouse-reprint/pallet-renderings-v2")
      .send({ value: "a".repeat(1024 * 1024) })
      .expect(413);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
