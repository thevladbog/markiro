import { createServer, type Server } from "node:http";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { mountAuth } from "../src/auth/auth.setup";

function testAuth(): Parameters<typeof mountAuth>[1] {
  return {
    handler: async () => new Response(null, { status: 204 }),
  };
}

let server: Server | undefined;

/**
 * Binds the app ONCE on `127.0.0.1` and hands supertest the listening server,
 * mirroring `openapi-docs.test.ts` (the Nest equivalent is
 * `support/listen-loopback.ts`, which carries the full write-up).
 *
 * Handing `request()` the bare express app instead makes supertest bind a
 * fresh ephemeral port per REQUEST on the `::` wildcard, which SO_REUSEADDR
 * lets succeed on a port an unrelated local process already holds on
 * `127.0.0.1` -- the kernel then routes that request to the stranger. This
 * file is where that goes from wasteful to actively misleading: the first
 * test fires 60 requests it expects to 404, and a stranger's 404 satisfies
 * `.expect(404)` just as well as ours does. Our limiter never counted that
 * request, so the 61st is only its 60th hit and comes back 404 instead of
 * 429 -- a rate-limiting assertion failing for a reason that has nothing to
 * do with rate limiting, on a run where nothing was even concurrent.
 */
async function bindApp(): Promise<Server> {
  const app = express();
  mountAuth(app, testAuth(), { allowTestSignUp: false });
  const bound = createServer(app);
  await new Promise<void>((resolve, reject) => {
    bound.once("error", reject);
    bound.listen(0, "127.0.0.1", () => {
      bound.off("error", reject);
      resolve();
    });
  });
  server = bound;
  return bound;
}

afterEach(async () => {
  const bound = server;
  server = undefined;
  if (!bound) return;
  await new Promise<void>((resolve, reject) => {
    bound.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("raw organization route policy", () => {
  it("rate-limits repeated attempts to reach blocked organization mutations", async () => {
    const app = await bindApp();

    for (let attempt = 0; attempt < 60; attempt += 1) {
      await request(app).post("/api/auth/organization/create").expect(404);
    }

    const limited = await request(app).post("/api/auth/organization/create").expect(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("does not charge unrelated organization reads against the mutation budget", async () => {
    const app = await bindApp();

    for (let attempt = 0; attempt < 75; attempt += 1) {
      await request(app).get("/api/auth/organization/list").expect(204);
    }

    await request(app).post("/api/auth/organization/create").expect(404);
  });
});
