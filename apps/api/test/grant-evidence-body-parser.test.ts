import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { grantEvidenceBodyParser } from "../src/modules/device-grants/evidence-body-parser";
import { productLabelValueDigest } from "@markiro/domain";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
describe("negotiated evidence raw transport", () => {
  it("captures original bytes while canonical logical identity ignores JSON formatting", async () => {
    const app = express();
    app.use(grantEvidenceBodyParser);
    app.use(express.json());
    app.post("/station/grants/v1/evidence/scans", (req, res) => {
      const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
      res.json({
        raw: raw?.toString(),
        hash: createHash("sha256")
          .update(raw ?? "")
          .digest("hex"),
        logical: productLabelValueDigest(req.body),
      });
    });
    const server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      const a = '{"a":"01ABC\\u001d91XYZ","b":1}',
        b = '{ "b": 1, "a": "01ABC\\u001d91XYZ" }';
      const first = await request(server)
        .post("/station/grants/v1/evidence/scans")
        .set("Content-Type", "application/json")
        .send(a)
        .expect(200);
      const second = await request(server)
        .post("/station/grants/v1/evidence/scans")
        .set("Content-Type", "application/json")
        .send(b)
        .expect(200);
      expect(first.body.raw).toBe(a);
      expect(second.body.raw).toBe(b);
      expect(first.body.hash).not.toBe(second.body.hash);
      expect(first.body.logical).toBe(second.body.logical);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
