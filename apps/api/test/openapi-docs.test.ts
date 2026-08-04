import express from "express";
import { createServer, type Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mountOpenApiDocs } from "../src/openapi-docs";

function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)><\/script>/gi)].map((match) => {
    const source = match[1]?.match(/\bsrc=["']([^"']+)["']/i)?.[1];
    if (!source) throw new Error("documentation HTML contains an inline script");
    return source;
  });
}

describe("self-hosted OpenAPI documentation", () => {
  let server: Server;

  beforeAll(async () => {
    const app = express();
    mountOpenApiDocs(app);
    server = createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  });

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it.each(["/docs", "/docs/"])("serves a CSP-compatible same-origin shell at %s", async (path) => {
    const response = await request(server).get(path).expect(200).expect("content-type", /html/);

    expect(scriptSources(response.text)).toEqual(["/docs/scalar.js", "/docs/bootstrap.js"]);
    expect(response.text).toContain('<div id="app"></div>');
    expect(response.text).not.toMatch(/\b(?:src|href)=["'](?:https?:)?\/\//i);
  });

  it("serves the Scalar browser bundle from the API runtime", async () => {
    const response = await request(server)
      .get("/docs/scalar.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text.length).toBeGreaterThan(100_000);
    expect(response.text).toContain("createApiReference");
  });

  it("initializes Scalar from an external script against the same-origin OpenAPI document", async () => {
    const response = await request(server)
      .get("/docs/bootstrap.js")
      .expect(200)
      .expect("content-type", /javascript/);

    expect(response.text).toContain('Scalar.createApiReference("#app"');
    expect(response.text).toContain('url: "/openapi.json"');
    expect(response.text).toContain("withDefaultFonts: false");
    expect(response.text).not.toMatch(/https?:\/\//i);
  });

  it("does not turn unknown documentation resources into the documentation shell", async () => {
    await request(server).get("/docs/missing.js").expect(404);
  });
});
