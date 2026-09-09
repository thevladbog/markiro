import { randomUUID } from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nationalCatalogBodyParser } from "../src/modules/national-catalog/body-parser";
import { excludeExchangeRoute } from "../src/modules/exchange/exchange.module";
import { importApplySchema, importStartSchema } from "@markiro/platform-contracts";

describe("National Catalog finite route body parser", () => {
  const app = express();
  app.use(nationalCatalogBodyParser);
  app.use(excludeExchangeRoute(express.json()));
  app.post("/national-catalog/import-sessions", (req, res) => {
    const parsed = importStartSchema.safeParse(req.body);
    res.sendStatus(parsed.success ? 204 : 422);
  });
  app.post("/national-catalog/import-sessions/:id/applies", (req, res) =>
    res.sendStatus(importApplySchema.safeParse(req.body).success ? 204 : 422),
  );
  app.post("/products", (_req, res) => res.sendStatus(204));
  const server = createServer(app);
  beforeAll(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)));
  afterAll(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  it("accepts the full 100000 GTIN input via actual HTTP", async () => {
    const text = Array.from({ length: 100000 }, () => "04601234567893").join("\n");
    expect(text.length).toBe(1499999);
    await request(server)
      .post("/national-catalog/import-sessions")
      .send({ mode: "gtins", text })
      .expect(204);
  });
  it("accounts for worst-case JSON escaping within the 1500000 character bound", async () => {
    const text = "\\u0030".repeat(1500000);
    await request(server)
      .post("/national-catalog/import-sessions")
      .set("Content-Type", "application/json")
      .send('{"mode":"gtins","text":"' + text + '"}')
      .expect(204);
  });
  it("accepts100 full apply decisions above100KiB and rejects oversize apply transport", async () => {
    const body = {
      requestId: randomUUID(),
      decisions: Array.from({ length: 100 }, () => ({
        previewId: randomUUID(),
        acceptedEntryIds: Array.from({ length: 40 }, () => randomUUID()),
        linkAction: "attach",
        photo: { kind: "keep" },
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(100 * 1024);
    await request(server)
      .post(`/national-catalog/import-sessions/${randomUUID()}/applies`)
      .send(body)
      .expect(204);
    await request(server)
      .post(`/national-catalog/import-sessions/${randomUUID()}/applies`)
      .send({ payload: "0".repeat(9_001_024) })
      .expect(413);
  });
  it("rejects oversized transport and retains the generic route limit", async () => {
    await request(server)
      .post("/national-catalog/import-sessions")
      .send({ mode: "gtins", text: "0".repeat(9_001_024) })
      .expect(413);
    await request(server)
      .post("/products")
      .send({ text: "0".repeat(150000) })
      .expect(413);
  });
});
