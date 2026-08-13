import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { mountAuth } from "../src/auth/auth.setup";

function testAuth(): Parameters<typeof mountAuth>[1] {
  return {
    handler: async () => new Response(null, { status: 204 }),
  };
}

describe("raw organization route policy", () => {
  it("rate-limits repeated attempts to reach blocked organization mutations", async () => {
    const app = express();
    mountAuth(app, testAuth(), { allowTestSignUp: false });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await request(app).post("/api/auth/organization/create").expect(404);
    }

    const limited = await request(app).post("/api/auth/organization/create").expect(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("does not charge unrelated organization reads against the mutation budget", async () => {
    const app = express();
    mountAuth(app, testAuth(), { allowTestSignUp: false });

    for (let attempt = 0; attempt < 75; attempt += 1) {
      await request(app).get("/api/auth/organization/list").expect(204);
    }

    await request(app).post("/api/auth/organization/create").expect(404);
  });
});
